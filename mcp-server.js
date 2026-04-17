#!/usr/bin/env node
/**
 * MYL MCP Server — Zoho CRM + Synthflow tools for Claude
 *
 * Exposes tools so Claude can:
 *   • Fetch / search / update Zoho leads
 *   • Trigger Synthflow AI calls
 *   • Pull dashboard KPIs and call logs
 *   • Create notes, tasks, and bookings
 *
 * Add to ~/.claude/settings.json:
 *   "mcpServers": {
 *     "myl": {
 *       "command": "node",
 *       "args": ["/Users/livingbrhman/myl-zoho-workflow/mcp-server.js"],
 *       "env": {}
 *     }
 *   }
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const axios = require('axios');

// ── CONFIG (mirrors server.js — reads env vars or falls back to hardcoded dev values) ──
const CFG = {
  synthflow: {
    apiKey:  process.env.SYNTHFLOW_API_KEY  || '1mVbM6zj-79hvVKzhYxinn-Zlm9s9wca4-C9c43KgcQ',
    baseUrl: 'https://api.synthflow.ai/v2',
    agents: {
      speedToLead:      process.env.AGENT_SPEED_TO_LEAD      || 'b81f2830-4467-4725-92d3-578ee75e11bd',
      landingPage:      process.env.AGENT_LANDING_PAGE       || '4f887b24-3a17-4b73-b4b3-0ea3bc031a97',
      conversionCloser: process.env.AGENT_CONVERSION_CLOSER  || '',
      onboarding:       process.env.AGENT_ONBOARDING         || '',
      reengagement:     process.env.AGENT_REENGAGEMENT       || '',
    },
  },
  zoho: {
    clientId:     process.env.ZOHO_CLIENT_ID     || '1000.U89IELOTL9LR9D89G9OL0BR6P4OVIG',
    clientSecret: process.env.ZOHO_CLIENT_SECRET || '4b4659f29bff6d8daf3885708d8cf8a70485eeecff',
    refreshToken: process.env.ZOHO_REFRESH_TOKEN || '1000.149cdc169aad2b1ad5df3f4bb049e6c5.684980ca9998f11acd25b3afd3ac1e20',
    accountUrl:   process.env.ZOHO_ACCOUNT_URL   || 'https://accounts.zoho.in',
    baseUrl:      process.env.ZOHO_BASE_URL      || 'https://www.zohoapis.in',
  },
  // Railway server URL — used for trigger_call which needs the full middleware flow
  serverUrl: process.env.MYL_SERVER_URL || 'https://myl-zoho-workflow-production.up.railway.app',
};

// ── ZOHO TOKEN ────────────────────────────────────────────────────────────────
let zohoAccessToken = null;
let tokenExpiry = 0;

async function getZohoToken() {
  if (zohoAccessToken && Date.now() < tokenExpiry) return zohoAccessToken;
  const res = await axios.post(`${CFG.zoho.accountUrl}/oauth/v2/token`, null, {
    params: {
      refresh_token: CFG.zoho.refreshToken,
      client_id:     CFG.zoho.clientId,
      client_secret: CFG.zoho.clientSecret,
      grant_type:    'refresh_token',
    },
  });
  zohoAccessToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return zohoAccessToken;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function fmtLead(l) {
  if (!l) return 'Lead not found.';
  return [
    `ID: ${l.id}`,
    `Name: ${l.First_Name || ''} ${l.Last_Name || ''}`.trim(),
    l.Phone     ? `Phone: ${l.Phone}` : null,
    l.Mobile    ? `Mobile: ${l.Mobile}` : null,
    l.Email     ? `Email: ${l.Email}` : null,
    l.Company   ? `Company: ${l.Company}` : null,
    l.Lead_Source ? `Source: ${l.Lead_Source}` : null,
    l.Lead_Status ? `Status: ${l.Lead_Status}` : null,
    l.Rating    ? `Rating: ${l.Rating}` : null,
    l.Buying_Intent ? `Buying Intent: ${l.Buying_Intent}` : null,
    l.Business_Stage ? `Business Stage: ${l.Business_Stage}` : null,
    l.garmentTypes ? `Garments: ${l.garmentTypes}` : null,
    l.estimatedOrderQuantity ? `MOQ: ${l.estimatedOrderQuantity}` : null,
    l.productionTimeline ? `Timeline: ${l.productionTimeline}` : null,
    l.AI_Last_Call_Status ? `Last AI Call Status: ${l.AI_Last_Call_Status}` : null,
    l.AI_Call_Duration !== undefined ? `AI Call Duration: ${l.AI_Call_Duration}s` : null,
    l.AI_Last_Call_Date ? `Last AI Call Date: ${l.AI_Last_Call_Date}` : null,
    l.AI_Agent_Used ? `Agent Used: ${l.AI_Agent_Used}` : null,
    l.AI_Call_Retry_Count !== undefined ? `Retry Count: ${l.AI_Call_Retry_Count}` : null,
    l.Description ? `\nDescription:\n${l.Description.slice(0, 500)}${l.Description.length > 500 ? '...' : ''}` : null,
  ].filter(Boolean).join('\n');
}

// ── MCP SERVER ────────────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'myl-workflow',
  version: '1.0.0',
});

// ── TOOL: get_dashboard ───────────────────────────────────────────────────────
server.tool(
  'myl_dashboard',
  'Get MYL AI Command Center KPIs, funnel stats, call outcomes, and recent call activity',
  {},
  async () => {
    try {
      const res = await axios.get(`${CFG.serverUrl}/api/dashboard-data`, { timeout: 15000 });
      const d = res.data;
      const k = d.kpis;
      const lines = [
        `=== MYL AI Dashboard — ${d.lastUpdated} ===`,
        '',
        '── KPIs ──',
        `Total Leads: ${k.totalLeads}  |  AI Calls Made: ${k.totalCalled}  |  Calls Today: ${k.callsToday}`,
        `Consultations Booked: ${k.consultationsBooked}  |  Converted: ${k.converted}  |  Hot Leads: ${k.hotLeads}`,
        `Success Rate: ${k.successRate}%  |  Connect Rate: ${k.connectRate}%  |  Avg Duration: ${Math.floor(k.avgDuration/60)}m ${k.avgDuration%60}s`,
        `Retry Queue: ${k.retryQueue}  |  Total Retries: ${k.totalRetries}`,
        '',
        '── Call Outcomes ──',
        ...Object.entries(d.charts.statusCounts).map(([s,n]) => `  ${s}: ${n}`),
        '',
        '── Lead Funnel ──',
        ...Object.entries(d.funnel).map(([s,n]) => `  ${s}: ${n}`),
        '',
        '── Recent Calls (last 15) ──',
        ...d.recentLeads.map(l =>
          `  ${l.name} | ${l.company} | ${l.status} | ${l.rating} | ${Math.floor(l.duration/60)}m${l.duration%60}s | ${l.date}`
        ),
      ];
      if (d.activeCalls.length > 0) {
        lines.push('', '── Active Calls ──');
        d.activeCalls.forEach(c => lines.push(`  Lead ${c.leadId} | Call ...${c.callId} | ${c.ageMin}m ago`));
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error fetching dashboard: ${err.message}` }] };
    }
  }
);

// ── TOOL: get_lead ────────────────────────────────────────────────────────────
server.tool(
  'myl_get_lead',
  'Fetch a Zoho CRM lead by its ID and return all AI call fields',
  { lead_id: z.string().describe('Zoho lead ID (numeric string)') },
  async ({ lead_id }) => {
    try {
      const token = await getZohoToken();
      const res = await axios.get(
        `${CFG.zoho.baseUrl}/crm/v2/Leads/${lead_id}?fields=id,First_Name,Last_Name,Phone,Mobile,Email,Company,Lead_Source,Rating,Lead_Status,Buying_Intent,Business_Stage,Industry,Title,City,State,Country,estimatedOrderQuantity,productionTimeline,garmentTypes,AI_Last_Call_Status,AI_Call_Duration,AI_Last_Call_Date,AI_Agent_Used,AI_Call_Retry_Count,Description`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const lead = res.data?.data?.[0];
      return { content: [{ type: 'text', text: fmtLead(lead) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── TOOL: search_leads ────────────────────────────────────────────────────────
server.tool(
  'myl_search_leads',
  'Search Zoho CRM leads by name, email, phone, or company. Returns up to 10 matches.',
  {
    query: z.string().describe('Search string — name, email, phone, or company'),
    criteria: z.enum(['email', 'phone', 'word']).optional().describe('Search type: email | phone | word (default: word)'),
  },
  async ({ query, criteria = 'word' }) => {
    try {
      const token = await getZohoToken();
      const res = await axios.get(
        `${CFG.zoho.baseUrl}/crm/v2/Leads/search?${criteria}=${encodeURIComponent(query)}&fields=id,First_Name,Last_Name,Phone,Mobile,Email,Company,Lead_Status,AI_Last_Call_Status,AI_Last_Call_Date,Rating,Buying_Intent`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const leads = res.data?.data || [];
      if (leads.length === 0) return { content: [{ type: 'text', text: 'No leads found.' }] };
      const lines = leads.slice(0, 10).map(l => [
        `ID: ${l.id} | ${l.First_Name || ''} ${l.Last_Name || ''}`.trim(),
        `  Phone: ${l.Phone || l.Mobile || '—'} | Email: ${l.Email || '—'}`,
        `  Company: ${l.Company || '—'} | Status: ${l.Lead_Status || '—'}`,
        `  Last AI Call: ${l.AI_Last_Call_Status || 'None'} on ${l.AI_Last_Call_Date ? new Date(l.AI_Last_Call_Date).toLocaleDateString('en-IN') : '—'}`,
      ].join('\n'));
      return { content: [{ type: 'text', text: `Found ${leads.length} lead(s):\n\n${lines.join('\n\n')}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── TOOL: trigger_call ────────────────────────────────────────────────────────
server.tool(
  'myl_trigger_call',
  'Manually trigger a Synthflow AI call for a Zoho lead via the MYL server. Uses agent auto-selection by default.',
  { lead_id: z.string().describe('Zoho lead ID') },
  async ({ lead_id }) => {
    try {
      const res = await axios.post(`${CFG.serverUrl}/api/lead/${lead_id}/call`, {}, { timeout: 20000 });
      const { callId, agentType } = res.data;
      return { content: [{ type: 'text', text: `Call triggered.\nCall ID: ${callId}\nAgent: ${agentType || 'SpeedToLead'}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error triggering call: ${err.response?.data?.error || err.message}` }] };
    }
  }
);

// ── TOOL: update_lead ─────────────────────────────────────────────────────────
server.tool(
  'myl_update_lead',
  'Update one or more fields on a Zoho CRM lead. Pass only the fields you want to change.',
  {
    lead_id: z.string().describe('Zoho lead ID'),
    fields: z.record(z.string(), z.unknown()).describe(
      'Key-value pairs of Zoho field API names and their new values. Examples: { "Lead_Status": "Pre-Qualified", "Buying_Intent": "Hot", "Description": "Updated notes..." }'
    ),
  },
  async ({ lead_id, fields }) => {
    try {
      const token = await getZohoToken();
      const res = await axios.put(
        `${CFG.zoho.baseUrl}/crm/v2/Leads/${lead_id}`,
        { data: [{ id: lead_id, ...fields }] },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const result = res.data?.data?.[0];
      return { content: [{ type: 'text', text: `Lead ${lead_id} updated.\nStatus: ${result?.code || 'OK'}\nFields changed: ${Object.keys(fields).join(', ')}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── TOOL: create_note ─────────────────────────────────────────────────────────
server.tool(
  'myl_create_note',
  'Add a note to a Zoho CRM lead',
  {
    lead_id: z.string().describe('Zoho lead ID'),
    title:   z.string().describe('Note title'),
    content: z.string().describe('Note body text'),
  },
  async ({ lead_id, title, content }) => {
    try {
      const token = await getZohoToken();
      await axios.post(
        `${CFG.zoho.baseUrl}/crm/v2/Leads/${lead_id}/Notes`,
        { data: [{ Note_Title: title, Note_Content: content, $se_module: 'Leads', Parent_Id: lead_id }] },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return { content: [{ type: 'text', text: `Note "${title}" created for lead ${lead_id}.` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── TOOL: create_task ─────────────────────────────────────────────────────────
server.tool(
  'myl_create_task',
  'Create a follow-up task for a Zoho CRM lead',
  {
    lead_id:     z.string().describe('Zoho lead ID'),
    lead_name:   z.string().describe('Lead display name (e.g. "Riya Sharma")'),
    subject:     z.string().describe('Task subject line'),
    description: z.string().optional().describe('Task details'),
    due_days:    z.number().int().min(0).max(30).optional().describe('Days from today until due (default: 1)'),
  },
  async ({ lead_id, lead_name, subject, description = '', due_days = 1 }) => {
    try {
      const token = await getZohoToken();
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + due_days);
      const dueDateStr = dueDate.toISOString().split('T')[0];
      await axios.post(
        `${CFG.zoho.baseUrl}/crm/v2/Tasks`,
        { data: [{ Subject: subject, Due_Date: dueDateStr, Description: description, Status: 'Not Started', Priority: 'High', $se_module: 'Leads', What_Id: { id: lead_id, name: lead_name } }] },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return { content: [{ type: 'text', text: `Task "${subject}" created for ${lead_name} — due ${dueDateStr}.` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── TOOL: list_recent_leads ───────────────────────────────────────────────────
server.tool(
  'myl_list_recent_leads',
  'List the most recently created leads from Zoho CRM (up to 25)',
  { count: z.number().int().min(1).max(25).optional().describe('How many to return (default: 10)') },
  async ({ count = 10 }) => {
    try {
      const token = await getZohoToken();
      const res = await axios.get(
        `${CFG.zoho.baseUrl}/crm/v2/Leads?fields=id,First_Name,Last_Name,Phone,Email,Company,Lead_Status,Lead_Source,AI_Last_Call_Status,AI_Last_Call_Date,Created_Time&sort_by=Created_Time&sort_order=desc&per_page=${count}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const leads = res.data?.data || [];
      if (leads.length === 0) return { content: [{ type: 'text', text: 'No leads found.' }] };
      const lines = leads.map((l, i) => {
        const name = `${l.First_Name || ''} ${l.Last_Name || ''}`.trim() || 'Unknown';
        const created = l.Created_Time ? new Date(l.Created_Time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' }) : '—';
        return `${i + 1}. [${l.id}] ${name} | ${l.Company || '—'} | ${l.Lead_Status || '—'} | AI: ${l.AI_Last_Call_Status || 'Not Called'} | Created: ${created}`;
      });
      return { content: [{ type: 'text', text: `Recent ${leads.length} leads:\n\n${lines.join('\n')}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── TOOL: get_synthflow_call ──────────────────────────────────────────────────
server.tool(
  'myl_get_synthflow_call',
  'Fetch details of a specific Synthflow call by call ID — includes transcript, duration, end reason',
  { call_id: z.string().describe('Synthflow call ID (UUID)') },
  async ({ call_id }) => {
    try {
      const res = await axios.get(
        `${CFG.synthflow.baseUrl}/calls/${call_id}`,
        { headers: { Authorization: `Bearer ${CFG.synthflow.apiKey}` } }
      );
      const call = res.data?.response?.calls?.[0];
      if (!call) return { content: [{ type: 'text', text: 'Call not found.' }] };
      return {
        content: [{
          type: 'text',
          text: [
            `Call ID: ${call_id}`,
            `Status: ${call.status || '—'}`,
            `Duration: ${call.duration || 0}s`,
            `End Reason: ${call.end_call_reason || '—'}`,
            `Phone: ${call.phone || '—'}`,
            call.transcript ? `\n── Transcript ──\n${call.transcript}` : '\n(No transcript)',
          ].join('\n'),
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── TOOL: list_synthflow_calls ────────────────────────────────────────────────
server.tool(
  'myl_list_synthflow_calls',
  'List recent Synthflow calls for a given agent (model). Returns up to 20.',
  {
    agent_type: z.enum(['speedToLead', 'landingPage', 'conversionCloser', 'onboarding', 'reengagement'])
      .optional()
      .describe('Which agent to query (default: speedToLead)'),
    limit: z.number().int().min(1).max(20).optional().describe('Max results (default: 10)'),
  },
  async ({ agent_type = 'speedToLead', limit = 10 }) => {
    try {
      const modelId = CFG.synthflow.agents[agent_type];
      if (!modelId) return { content: [{ type: 'text', text: `Agent "${agent_type}" has no ID configured yet.` }] };

      const res = await axios.get(
        `${CFG.synthflow.baseUrl}/calls?model_id=${modelId}&limit=${limit}`,
        { headers: { Authorization: `Bearer ${CFG.synthflow.apiKey}` } }
      );
      const calls = res.data?.response?.calls || res.data?.calls || [];
      if (calls.length === 0) return { content: [{ type: 'text', text: 'No calls found.' }] };
      const lines = calls.map((c, i) =>
        `${i + 1}. [${c.call_id || c._id}] ${c.phone || '—'} | ${c.duration || 0}s | ${c.end_call_reason || '—'} | ${c.status || '—'}`
      );
      return { content: [{ type: 'text', text: `${calls.length} call(s) for ${agent_type}:\n\n${lines.join('\n')}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── TOOL: server_health ───────────────────────────────────────────────────────
server.tool(
  'myl_server_health',
  'Check the health of the MYL Railway server — uptime, retry queue size, tunnel URL',
  {},
  async () => {
    try {
      const res = await axios.get(`${CFG.serverUrl}/health`, { timeout: 8000 });
      const h = res.data;
      return {
        content: [{
          type: 'text',
          text: [
            `Server: OK`,
            `Time: ${h.timestamp}`,
            `Retry Queue: ${h.retryQueue} leads pending`,
            `Server URL: ${h.tunnel}`,
          ].join('\n'),
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Server unreachable: ${err.message}` }] };
    }
  }
);

// ── TOOL: coql_query ──────────────────────────────────────────────────────────
server.tool(
  'myl_zoho_query',
  'Run a COQL (Zoho CRM query language) SELECT statement to pull custom lead data. Use for reporting or bulk lookups.',
  { query: z.string().describe('COQL SELECT query, e.g.: SELECT id, First_Name, Lead_Status FROM Leads WHERE AI_Last_Call_Status = \'No Answer\' LIMIT 10') },
  async ({ query }) => {
    try {
      const token = await getZohoToken();
      const res = await axios.post(
        `${CFG.zoho.baseUrl}/crm/v2/coql`,
        { select_query: query },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      const rows = res.data?.data || [];
      if (rows.length === 0) return { content: [{ type: 'text', text: 'Query returned 0 rows.' }] };
      const headers = Object.keys(rows[0]);
      const lines = [
        headers.join(' | '),
        headers.map(() => '---').join(' | '),
        ...rows.map(r => headers.map(h => String(r[h] ?? '')).join(' | ')),
      ];
      return { content: [{ type: 'text', text: `${rows.length} row(s):\n\n${lines.join('\n')}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Query error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── START ─────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP servers must not write to stdout (reserved for JSON-RPC) — use stderr for logs
  process.stderr.write('[MYL MCP] Server running\n');
}

main().catch(err => {
  process.stderr.write(`[MYL MCP] Fatal: ${err.message}\n`);
  process.exit(1);
});
