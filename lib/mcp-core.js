'use strict';

// Shared MCP tool definitions and handlers.
// Used by both the local stdio server (mcp-server.js) and the remote HTTP endpoint (routes/mcp.js).

const { blueprint, consultBrain, enrichCall } = require('../brain');
const { getLead, searchLeadByName, updateLead, addNote, addTask, createLead, createDeal } = require('../crm/zoho');
const { getAgentForPhone, triggerCall } = require('../voice/synthflow');
const { sendBrandReport } = require('../email/resend');
const { getRecentCalls, storeBlueprint, getLatestPattern } = require('../store/supabase');
const { refreshPatterns, buildContextBlock } = require('../brain/patterns');
const { anthropic } = require('../config');
const axios = require('axios');

const SF_BASE   = 'https://api.synthflow.ai/v2';
const agentId   = () => process.env.AGENT_US || process.env.AGENT_IN || '';
const sfHeaders = () => ({ Authorization: `Bearer ${process.env.SYNTHFLOW_API_KEY}` });

// ── Tool definitions ───────────────────────────────────────────
const TOOLS = [

  // ── Core CRM & Calls ──────────────────────────────────────────
  {
    name:        'myl_server_health',
    description: 'Check MYL Brain server status and version.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'myl_trigger_call',
    description: 'Trigger an outbound Synthflow call to a founder. Creates a Zoho CRM lead and dials immediately. Phone must include country code.',
    inputSchema: {
      type: 'object',
      required: ['name', 'email', 'phone'],
      properties: {
        name:     { type: 'string', description: 'Founder full name' },
        email:    { type: 'string', description: 'Email address' },
        phone:    { type: 'string', description: 'Phone with country code e.g. +447911123456' },
        business: { type: 'string', description: 'Brand or business name' },
        goal:     { type: 'string', description: 'What they want to achieve' },
        category: { type: 'string', description: 'Garment type e.g. dresses, streetwear' },
        market:   { type: 'string', description: 'UK, US, India, or UAE' },
      },
    },
  },
  {
    name:        'myl_dashboard',
    description: 'Get the call insights dashboard — total calls, hot/warm/cold breakdown, average lead score, design-ready count.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'myl_list_recent_leads',
    description: 'List the most recent enriched calls/leads from the database.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max records to return (default 20, max 50)' },
      },
    },
  },
  {
    name:        'myl_search_leads',
    description: 'Search leads in Zoho CRM by email or name.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address to search for' },
        name:  { type: 'string', description: 'Name to search for' },
      },
    },
  },
  {
    name:        'myl_get_lead',
    description: 'Look up a lead in Zoho CRM by email address.',
    inputSchema: {
      type: 'object',
      required: ['email'],
      properties: {
        email: { type: 'string', description: 'Lead email address' },
      },
    },
  },
  {
    name:        'myl_update_lead',
    description: 'Update a lead record in Zoho CRM.',
    inputSchema: {
      type: 'object',
      required: ['email'],
      properties: {
        email:               { type: 'string' },
        leadScore:           { type: 'number', description: '0-100' },
        leadQuality:         { type: 'string', description: 'Hot, Warm, or Cold' },
        callSummary:         { type: 'string' },
        founderStage:        { type: 'string', description: 'IDEA, HAS_DESIGN, HAS_SAMPLE, SELLING, SCALING' },
        designReadiness:     { type: 'string' },
        validationAppetite:  { type: 'string', description: 'HIGH, MEDIUM, or LOW' },
        journeyStageRevenue: { type: 'string' },
      },
    },
  },
  {
    name:        'myl_create_note',
    description: 'Add a co-founder note to a lead in Zoho CRM.',
    inputSchema: {
      type: 'object',
      required: ['email', 'note'],
      properties: {
        email: { type: 'string' },
        note:  { type: 'string' },
      },
    },
  },
  {
    name:        'myl_create_task',
    description: 'Create a follow-up task on a lead in Zoho CRM.',
    inputSchema: {
      type: 'object',
      required: ['email', 'task'],
      properties: {
        email:    { type: 'string' },
        task:     { type: 'string' },
        due_date: { type: 'string', description: 'YYYY-MM-DD (default: 2 days from now)' },
      },
    },
  },
  {
    name:        'myl_get_patterns',
    description: 'Get AI-extracted pattern intelligence for a founder segment.',
    inputSchema: {
      type: 'object',
      properties: {
        stage:    { type: 'string', description: 'IDEA, HAS_DESIGN, HAS_SAMPLE, SELLING, SCALING, or all' },
        category: { type: 'string', description: 'Garment category or all' },
      },
    },
  },
  {
    name:        'myl_refresh_patterns',
    description: 'Trigger AI pattern extraction from the last 60 calls for a segment.',
    inputSchema: {
      type: 'object',
      properties: {
        stage:    { type: 'string' },
        category: { type: 'string' },
      },
    },
  },

  // ── Agent Training & System ───────────────────────────────────
  {
    name:        'myl_system_overview',
    description: 'Get the full MYL system architecture — how the intake, voice AI, brain loop, CRM, email, and payment flows connect. Use this to understand or explain how the system is built.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'myl_get_agent_script',
    description: 'Get the current Synthflow voice agent prompt/script plus config (phone number, webhook, LLM). Use this to review or audit what Alex says on calls.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'myl_update_agent_script',
    description: 'Update the Synthflow voice agent prompt live — changes take effect on the next call. Always fetch the current script first.',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Full new prompt for the voice agent.' },
      },
    },
  },
  {
    name:        'myl_get_actions',
    description: 'List all 5 Synthflow tool actions wired to the voice agent — names, Railway URLs, variables, descriptions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'myl_test_blueprint',
    description: 'Dry-run the Claude blueprint generator with founder data. Returns a full brand blueprint without triggering a call or sending an email.',
    inputSchema: {
      type: 'object',
      properties: {
        name:     { type: 'string' },
        business: { type: 'string' },
        goal:     { type: 'string' },
        category: { type: 'string', description: 'e.g. streetwear, dresses' },
        stage:    { type: 'string', description: 'IDEA, HAS_DESIGN, HAS_SAMPLE, SELLING, SCALING' },
      },
    },
  },
  {
    name:        'myl_get_call_transcripts',
    description: 'Get recent call transcripts for training review — includes scores, founder stage, summary, and full transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of calls (default 5, max 50)' },
      },
    },
  },
  {
    name:        'myl_send_blueprint_email',
    description: 'Manually send a brand blueprint email to a founder.',
    inputSchema: {
      type: 'object',
      required: ['email', 'name'],
      properties: {
        email:     { type: 'string' },
        name:      { type: 'string' },
        blueprint: { type: 'object', description: 'Blueprint object (optional — omit to generate one)' },
      },
    },
  },
  {
    name:        'myl_crm_intelligence',
    description: 'MYL Intelligence owner dashboard — full ecosystem view of Alex\'s call performance: total calls, quality breakdown, avg score, segment patterns, top objections, conversion funnel. Use this to understand how the AI ecosystem is performing.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name:        'myl_copilot',
    description: 'MYL AI Copilot — your system partner who knows everything. Give it any instruction: train Alex on a new objection, fix a weakness in the script, analyse why calls are going cold, update the agent based on recent call data, or ask anything about the system. Set apply:true to execute the change immediately.',
    inputSchema: {
      type: 'object',
      required: ['instruction'],
      properties: {
        instruction: { type: 'string', description: 'Your instruction, training command, or question. Be specific.' },
        apply:       { type: 'boolean', description: 'true = apply the change immediately. false (default) = return plan only.' },
      },
    },
  },
];

// ── Tool handlers ──────────────────────────────────────────────
async function handleTool(name, args) {
  switch (name) {

    case 'myl_server_health':
      return {
        status:      'ok',
        version:     'MYL Brain v2 — journey-first',
        sandbox:     process.env.SANDBOX_MODE === 'true',
        time:        new Date().toISOString(),
      };

    case 'myl_trigger_call': {
      const { name: n, email, phone, business, goal, category, market } = args;
      const aid = getAgentForPhone(phone);
      if (!aid) return { error: 'No agent configured for this region' };
      createLead({ name: n, email, phone, business, goal, category })
        .catch(e => console.warn('[mcp trigger_call] Zoho createLead failed (non-fatal):', e.message));
      const segment_intel = await buildContextBlock({ category }).catch(() => '');
      await triggerCall({
        to: phone, agentId: aid,
        variables: {
          name: n, email: email || '', business: business || '',
          goal: goal || 'launch my fashion label', category: category || '',
          market: market || '',
          segment_intel: segment_intel || '',
          today: new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
        },
      });
      return { triggered: true };
    }

    case 'myl_dashboard': {
      const calls = await getRecentCalls(200);
      const hot  = calls.filter(c => c.lead_quality === 'Hot').length;
      const warm = calls.filter(c => c.lead_quality === 'Warm').length;
      const cold = calls.filter(c => c.lead_quality === 'Cold').length;
      const scores = calls.map(c => c.lead_score).filter(Boolean);
      const avg_score = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
      return {
        calls, summary: {
          total: calls.length, hot, warm, cold, avg_score,
          design_ready:      calls.filter(c => c.design_readiness === 'READY').length,
          high_validation:   calls.filter(c => c.validation_appetite === 'HIGH').length,
          recommended_pro:   calls.filter(c => (c.lead_score || 0) >= 70).length,
        },
      };
    }

    case 'myl_list_recent_leads': {
      const calls = await getRecentCalls(Math.min(args.limit || 20, 50));
      return { calls: calls.map(c => ({
        call_id:    c.call_id,
        duration:   c.duration_seconds,
        quality:    c.lead_quality,
        score:      c.lead_score,
        stage:      c.founder_stage,
        category:   c.garment_category,
        summary:    c.summary,
        next_step:  c.next_step,
        created_at: c.created_at,
      })) };
    }

    case 'myl_search_leads': {
      const lead = args.email
        ? await getLead(args.email)
        : await searchLeadByName(args.name);
      return lead || { error: 'Lead not found' };
    }

    case 'myl_get_lead': {
      const lead = await getLead(args.email);
      return lead || { error: 'Lead not found' };
    }

    case 'myl_update_lead':
      await updateLead(args);
      return { updated: true };

    case 'myl_create_note':
      await addNote(args);
      return { created: true };

    case 'myl_create_task':
      await addTask(args);
      return { created: true };

    case 'myl_get_patterns': {
      const pattern = await getLatestPattern({
        category: args.category || 'all',
        stage:    args.stage    || 'all',
      });
      return pattern || { message: 'No patterns yet — need ≥5 calls for this segment' };
    }

    case 'myl_refresh_patterns': {
      const result = await refreshPatterns({
        category: args.category || 'all',
        stage:    args.stage    || 'all',
      });
      return result;
    }

    case 'myl_system_overview':
      return {
        system: 'MYL Brain v2 — design → validate → scale winners',
        stack: {
          voice:    'Synthflow gpt-4.1 outbound AI (MYL-Alex-v2, +16057020508)',
          brain:    'Anthropic Claude — Opus 4.7 (blueprint), Sonnet 4.6 (consult/enrich), Haiku (patterns)',
          crm:      'Zoho CRM India (leads, deals, notes, tasks)',
          db:       'Supabase PostgreSQL (calls, blueprints, panel_accounts, call_patterns)',
          email:    'Resend — alex@updates.makeyourlabel.com (personal template, Primary inbox)',
          payments: 'PayPal sandbox → production',
          infra:    'Node.js/Express on Railway (auto-deploy from GitHub main)',
        },
        flow: {
          intake:      'POST /api/intake → createLead(Zoho) → triggerCall(Synthflow)',
          during_call: ['get_brand_blueprint (Claude Opus)', 'consult_brain (Claude Sonnet)', 'send_brand_email (Resend)', 'tag_prospect (Zoho)', 'book_consultation (Zoho deal)'],
          after_call:  'webhook/synthflow → enrichCall(Sonnet) → insertCall(Supabase) → updateLead(Zoho) → refreshPatterns(Haiku)',
          brain_loop:  'Haiku extracts patterns from last 60 calls → injected as LIVE INTELLIGENCE into next blueprint + consult',
          payment:     'PayPal webhook → verifySignature → createPanelAccount(Supabase) → sendWelcomeEmail',
        },
        agent_actions: {
          get_brand_blueprint: '/api/agent/blueprint',
          consult_brain:       '/api/agent/consult-brain',
          send_brand_email:    '/api/agent/send-brand-email',
          tag_prospect:        '/api/agent/tag-prospect',
          book_consultation:   '/api/agent/book-consultation',
        },
      };

    case 'myl_get_agent_script': {
      const id = agentId();
      const r  = await axios.get(`${SF_BASE}/assistants/${id}`, { headers: sfHeaders() });
      const a  = r.data?.response?.assistants?.[0] || {};
      return {
        id, name: a.name, phone: a.phone_number,
        webhook: a.external_webhook_url,
        llm: a.agent?.llm, voice: a.agent?.voice_id,
        prompt: a.agent?.prompt || '',
      };
    }

    case 'myl_update_agent_script': {
      const id = agentId();
      await axios.put(`${SF_BASE}/assistants/${id}`, { agent: { prompt: args.prompt } }, {
        headers: { ...sfHeaders(), 'Content-Type': 'application/json' },
      });
      return { updated: true, agent_id: id };
    }

    case 'myl_get_actions': {
      const r = await axios.get(`${SF_BASE}/actions?assistant_id=${agentId()}`, { headers: sfHeaders() });
      return (r.data?.response?.actions || []).map(a => ({
        id:          a.action_id,
        name:        a.name,
        description: a.parameters_hard_coded?.description,
        url:         a.parameters_hard_coded?.url,
        variables:   (a.parameters_hard_coded?.variables_during_the_call || []).map(v => v.name),
      }));
    }

    case 'myl_test_blueprint': {
      const {
        name:     n = 'Test Founder',
        business: b = 'Sample Brand',
        goal:     g = 'launch my first collection',
        category: c = 'streetwear',
        stage:    s = 'IDEA',
      } = args;
      const result = await blueprint({ name: n, business: b, goal: g, data: { category: c, stage: s } });
      return { blueprint: result, inputs: { name: n, business: b, goal: g, category: c, stage: s } };
    }

    case 'myl_get_call_transcripts': {
      const calls = await getRecentCalls(Math.min(args.limit || 5, 50));
      return calls.map(c => ({
        call_id:    c.call_id,
        duration:   c.duration_seconds,
        score:      c.lead_score,
        quality:    c.lead_quality,
        stage:      c.founder_stage,
        category:   c.garment_category,
        summary:    c.summary,
        transcript: c.transcript,
        created_at: c.created_at,
      }));
    }

    case 'myl_send_blueprint_email': {
      const { email, name: n, blueprint: bp } = args;
      const bpData = bp || (await blueprint({ name: n, business: '', goal: '', data: {} }).catch(() => null));
      await sendBrandReport({ to: email, name: n, blueprint: bpData });
      return { sent: true };
    }

    case 'myl_crm_intelligence': {
      const calls = await getRecentCalls(200);
      const hot   = calls.filter(c => c.lead_quality === 'Hot').length;
      const warm  = calls.filter(c => c.lead_quality === 'Warm').length;
      const cold  = calls.filter(c => c.lead_quality === 'Cold').length;
      const scores = calls.map(c => c.lead_score).filter(n => typeof n === 'number' && n > 0);
      const avg_score = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

      const byCat = {};
      calls.forEach(c => {
        const cat = c.garment_category || 'unknown';
        byCat[cat] = (byCat[cat] || 0) + 1;
      });

      const byStage = {};
      calls.forEach(c => {
        const stage = c.founder_stage || 'unknown';
        byStage[stage] = (byStage[stage] || 0) + 1;
      });

      const durations = calls.map(c => c.duration_seconds || 0).filter(d => d > 0);
      const avg_duration_s = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

      const patterns = await getLatestPattern({ category: 'all', stage: 'all' }).catch(() => null);

      return {
        ecosystem:            'MYL Alex — Outbound AI Call Ecosystem',
        total_calls_handled:  calls.length,
        quality_breakdown:    { hot, warm, cold },
        avg_lead_score:       avg_score,
        avg_duration_seconds: avg_duration_s,
        conversion_funnel: {
          design_ready:              calls.filter(c => c.design_readiness && c.design_readiness !== 'NONE').length,
          high_validation_appetite:  calls.filter(c => c.validation_appetite === 'HIGH').length,
          recommended_pro_tier:      calls.filter(c => (c.lead_score || 0) >= 70).length,
        },
        segment_breakdown: byCat,
        stage_breakdown:   byStage,
        pattern_intel: {
          top_objections:    patterns?.content?.common_objections || [],
          what_converts:     patterns?.content?.what_converts     || 'Not enough data yet',
          cofounder_insight: patterns?.content?.cofounder_insight || 'Not enough data yet',
          hot_signals:       patterns?.content?.hot_signals       || [],
          freshness:         patterns ? `${patterns.call_count} calls — ${patterns.generated_at}` : 'No patterns yet',
        },
      };
    }

    case 'myl_copilot': {
      const { instruction, apply = false } = args;

      // Load full system context in parallel
      const [agentResp, recentCalls, patterns] = await Promise.all([
        axios.get(`${SF_BASE}/assistants/${agentId()}`, {
          headers: { ...sfHeaders(), 'User-Agent': 'Mozilla/5.0' },
        }).then(r => r.data?.response?.assistants?.[0] || {}).catch(() => ({})),
        getRecentCalls(20).catch(() => []),
        getLatestPattern({ category: 'all', stage: 'all' }).catch(() => null),
      ]);

      const currentPrompt = agentResp?.agent?.prompt || '';

      const callSummaries = recentCalls.slice(0, 10).map(c => ({
        quality:        c.enrichment?.lead_quality,
        score:          c.enrichment?.lead_score,
        stage:          c.enrichment?.founder_stage,
        category:       c.enrichment?.garment_category,
        summary:        c.enrichment?.summary,
        objections:     c.enrichment?.objections,
        myl_vs_mfr:     c.enrichment?.myl_vs_manufacturer_moment,
        sell_seed:      c.enrichment?.sell_seed_resonance,
        next_step:      c.enrichment?.next_step,
        cofounder_note: c.enrichment?.cofounder_note,
      }));

      const COPILOT_SYSTEM = `You are the MYL Brain Copilot — the intelligent system partner of the founder of MakeYourLabel.

You have full access to the live system: the Synthflow voice agent prompt, recent call enrichment data, and pattern intelligence extracted from real calls.

MYL is a Design→Validate→Scale brand management partner — NOT a manufacturer.
The two wins: SELL (product resonates, scale with confidence) or SEED (found out for $2,500 not $30,000).

Your job: understand the founder's instruction, analyse the relevant context, and respond with exactly what to do — or do it if apply=true.

Return JSON only:
{
  "analysis":      "what you found in the context that is relevant to this instruction",
  "recommendation":"what specifically should change and why — be precise, reference exact lines/sections",
  "action_type":   "update_agent_prompt | analysis_only",
  "new_prompt":    "ONLY when action_type=update_agent_prompt AND apply=true — the COMPLETE updated agent prompt, nothing omitted",
  "summary":       "one sentence: what you did or what the founder should do next"
}`;

      const contextPayload = `INSTRUCTION: ${instruction}
APPLY: ${apply}

CURRENT AGENT PROMPT (Alex's live script):
${currentPrompt.slice(0, 4000)}${currentPrompt.length > 4000 ? '\n[...truncated...]' : ''}

RECENT CALL DATA (last 10 calls):
${JSON.stringify(callSummaries, null, 2)}

PATTERN INTELLIGENCE:
${patterns ? JSON.stringify(patterns.content, null, 2) : 'No patterns extracted yet'}`;

      const res = await anthropic.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 8000,
        system:     COPILOT_SYSTEM,
        messages:   [{ role: 'user', content: contextPayload }],
      });

      const raw = res.content[0].text.replace(/```json|```/g, '').trim();
      let result;
      try {
        result = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      } catch {
        return { analysis: raw, recommendation: '', action_type: 'analysis_only', summary: 'Raw response (JSON parse failed)' };
      }

      // Execute if apply=true and action is a prompt update
      if (apply && result.action_type === 'update_agent_prompt' && result.new_prompt) {
        await axios.put(
          `${SF_BASE}/assistants/${agentId()}`,
          { agent: { prompt: result.new_prompt } },
          { headers: { ...sfHeaders(), 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' } },
        );
        result.applied = true;
        result.summary  = '[APPLIED] ' + result.summary;
      }

      return result;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOLS, handleTool };
