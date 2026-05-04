'use strict';

const router   = require('express').Router();
const axios    = require('axios');
const { blueprint } = require('../brain');
const { getRecentCalls } = require('../store/supabase');
const { requireAuth }    = require('../middleware/auth');

const SF_BASE    = 'https://api.synthflow.ai/v2';
const agentId    = () => process.env.AGENT_US || process.env.AGENT_IN || '';
const sfHeaders  = () => ({ Authorization: `Bearer ${process.env.SYNTHFLOW_API_KEY}` });

router.use(requireAuth);

// ── GET /api/training/overview ─────────────────────────────────
// Full architecture doc — how the whole system fits together.
router.get('/overview', (req, res) => {
  res.json({
    system:   'MYL Brain v2 — design → validate → scale winners',
    version:  '2.0.0',
    stack: {
      voice:   'Synthflow gpt-4.1 outbound AI (MYL-Alex-v2)',
      brain:   'Anthropic Claude — Opus 4.7 (blueprint), Sonnet 4.6 (consult/enrich), Haiku (patterns)',
      crm:     'Zoho CRM India (leads, deals, notes, tasks)',
      db:      'Supabase PostgreSQL (calls, blueprints, panel_accounts, call_patterns)',
      email:   'Resend — alex@updates.makeyourlabel.com (personal template, Primary inbox)',
      payments:'PayPal sandbox → production',
      infra:   'Node.js/Express on Railway (auto-deploy from GitHub main)',
    },
    flow: {
      '1_intake':        'POST /api/intake { name, email, phone, business, goal, category } → createLead(Zoho) → triggerCall(Synthflow)',
      '2_during_call': [
        'PHASE 1 — OPEN: "Hey {{name}}! This is Alex from Make Your Label..."',
        'PHASE 2 — UNDERSTAND: ask category, occasion, customer, stage, blocker, validation status',
        'PHASE 3 — MANDATORY: call get_brand_blueprint as soon as category+stage+blocker known',
        'PHASE 4 — LIVE INSIGHT: call consult_brain for any specific question',
        'PHASE 5 — MODEL: explain 10-50 unit validation approach',
        'PHASE 6 — EMAIL: ask for email → call send_brand_email immediately',
        'PHASE 7 — DEEPEN (optional): offer co-founder call → book_consultation',
        'ALWAYS: call tag_prospect silently at end',
      ],
      '3_after_call':    'POST /webhook/synthflow → enrichCall(Sonnet) → insertCall(Supabase) → updateLead(Zoho) → refreshPatterns(Haiku)',
      '4_brain_loop':    'Haiku extracts patterns from last 60 calls per segment → injected as LIVE INTELLIGENCE into next blueprint + consult',
      '5_payment':       'PayPal webhook → verifySignature → createPanelAccount(Supabase) → sendWelcomeEmail(Resend)',
    },
    agent_actions: {
      get_brand_blueprint: { url: '/api/agent/blueprint',         when: 'MUST call once category+stage+blocker known. Claude Opus generates full blueprint.' },
      consult_brain:       { url: '/api/agent/consult-brain',     when: 'MUST call when founder says something specific. Use their exact words.' },
      send_brand_email:    { url: '/api/agent/send-brand-email',  when: 'MUST call the moment you have their email.' },
      tag_prospect:        { url: '/api/agent/tag-prospect',      when: 'Call silently after every call. Never mention to founder.' },
      book_consultation:   { url: '/api/agent/book-consultation', when: 'Call if founder wants next steps.' },
    },
    key_fields_returned_by_blueprint: [
      'brand_archetype    — their positioning identity',
      'first_design.moment_1 — exact first design to make',
      'validation_plan.units / go_signal / kill_signal',
      'scale_gate         — when to scale',
      '90_day_move        — one concrete next action',
      'reading            — personalised insight Alex delivers conversationally',
    ],
    env_vars_required: [
      'ANTHROPIC_API_KEY, SYNTHFLOW_API_KEY, AGENT_US/GB/IN',
      'ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN',
      'SUPABASE_URL, SUPABASE_ANON_KEY',
      'RESEND_API_KEY, EMAIL_FROM',
      'PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID',
      'API_SECRET (internal auth), BASE_URL, PANEL_URL',
    ],
  });
});

// ── GET /api/training/agent ────────────────────────────────────
// Current Synthflow agent prompt + config.
router.get('/agent', async (req, res) => {
  try {
    const id = agentId();
    const r  = await axios.get(`${SF_BASE}/assistants/${id}`, { headers: sfHeaders() });
    const a  = r.data?.response?.assistants?.[0] || {};
    res.json({
      id:      id,
      name:    a.name,
      phone:   a.phone_number,
      webhook: a.external_webhook_url,
      llm:     a.agent?.llm,
      voice:   a.agent?.voice_id,
      prompt:  a.agent?.prompt || '',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /api/training/agent  { prompt } ─────────────────────
// Update the Synthflow agent prompt live — no redeploy needed.
router.patch('/agent', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const id = agentId();
    await axios.put(
      `${SF_BASE}/assistants/${id}`,
      { agent: { prompt } },
      { headers: { ...sfHeaders(), 'Content-Type': 'application/json' } },
    );
    res.json({ updated: true, agent_id: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/training/actions ──────────────────────────────────
// List all Synthflow tool actions wired to this agent.
router.get('/actions', async (req, res) => {
  try {
    const r = await axios.get(
      `${SF_BASE}/actions?assistant_id=${agentId()}`,
      { headers: sfHeaders() },
    );
    const actions = r.data?.response?.actions || [];
    res.json(actions.map(a => ({
      id:          a.action_id,
      name:        a.name,
      description: a.parameters_hard_coded?.description,
      url:         a.parameters_hard_coded?.url,
      method:      a.parameters_hard_coded?.http_mode,
      variables:   (a.parameters_hard_coded?.variables_during_the_call || []).map(v => ({
        name: v.name, type: v.type, description: v.description,
      })),
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/training/test-blueprint ─────────────────────────
// Dry-run blueprint generation with sample or provided founder data.
router.post('/test-blueprint', async (req, res) => {
  try {
    const {
      name     = 'Test Founder',
      business = 'Sample Brand',
      goal     = 'launch my first collection',
      category = 'streetwear',
      stage    = 'IDEA',
    } = req.body;
    const result = await blueprint({ name, business, goal, data: { category, stage } });
    res.json({ blueprint: result, inputs: { name, business, goal, category, stage } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/training/calls ────────────────────────────────────
// Recent call transcripts for training review.
router.get('/calls', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const calls = await getRecentCalls(limit);
    res.json(calls.map(c => ({
      call_id:   c.call_id,
      duration:  c.duration_seconds,
      outcome:   c.outcome,
      score:     c.enrichment?.lead_score,
      quality:   c.enrichment?.lead_quality,
      stage:     c.enrichment?.founder_stage,
      category:  c.enrichment?.garment_category,
      summary:   c.enrichment?.summary,
      transcript: c.transcript,
      created_at: c.created_at,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
