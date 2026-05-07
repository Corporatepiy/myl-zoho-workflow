'use strict';

// Polls Zoho for leads created in the last 24 hours that haven't been called.
// Called by setInterval every 2 minutes (index.js) and exposed as POST /api/sync/leads.

const router = require('express').Router();
const axios  = require('axios');
const { getZohoToken } = require('../crm/zoho');
const { getAgentForPhone, triggerCall } = require('../voice/synthflow');
const { buildContextBlock } = require('../brain/patterns');

const CRM_BASE = 'https://www.zohoapis.in/crm/v2';

async function syncNewLeads() {
  if (process.env.SANDBOX_MODE === 'true') {
    console.log('[sync] sandbox mode — skipping');
    return { sandbox: true, skipped: true };
  }

  const token = await getZohoToken();

  // Use COQL to avoid the Zoho search-criteria parser treating colons inside
  // ISO timestamps (e.g. "14:52:57") as field:operator:value delimiters,
  // which silently returned 0 results via the /search endpoint.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const coqlRes = await axios.post(`${CRM_BASE}/coql`, {
    select_query: `select id, Full_Name, First_Name, Last_Name, Email, Phone, Mobile, Company, Description, Lead_Source, Garment_Category, Budget, Target_Market from Leads where Created_Time >= '${since}' and AI_Last_Call_Status is null limit 10`,
  }, { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' } })
    .catch(e => { console.warn('[sync] COQL error:', e.response?.data || e.message); return { data: { data: [] } }; });

  const leads = coqlRes.data?.data || [];
  const results = [];

  for (const lead of leads) {
    const phone = lead.Phone || lead.Mobile || '';
    if (!phone) {
      results.push({ name: lead.Full_Name, skipped: 'no phone' });
      continue;
    }

    const agentId = getAgentForPhone(phone);
    if (!agentId) {
      results.push({ name: lead.Full_Name, skipped: 'no agent for region' });
      continue;
    }

    const name          = lead.Full_Name || `${lead.First_Name || ''} ${lead.Last_Name || ''}`.trim();
    const category      = lead.Garment_Category || lead.Category || '';
    const segment_intel = await buildContextBlock({ category }).catch(() => '');

    await triggerCall({
      to: phone, agentId,
      variables: {
        name,
        email:    lead.Email       || '',
        business: lead.Company     || '',
        goal:     lead.Description || 'launch my fashion label',
        category,
        budget:   lead.Budget         || '',
        market:   lead.Target_Market  || '',
        source:   lead.Lead_Source    || 'zoho',
        segment_intel,
        today:    new Date().toLocaleDateString('en-US', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        }),
      },
    });

    // Mark as called so we don't redial on next poll
    await axios.put(`${CRM_BASE}/Leads/${lead.id}`, {
      data: [{ AI_Last_Call_Status: 'triggered', AI_Last_Call_Date: new Date().toISOString().split('T')[0] }],
    }, { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' } })
      .catch(() => {});

    results.push({ name, phone, triggered: true });
    console.log(`[sync] call triggered → ${phone} (${name})`);
  }

  return { synced: results.length, results };
}

// Internal cron endpoint — secured by API_SECRET
router.post('/leads', async (req, res) => {
  if (req.headers['x-api-secret'] !== process.env.API_SECRET &&
      req.query.secret !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await syncNewLeads();
    res.json(result);
  } catch (e) {
    console.error('[sync] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Manually trigger a call for a specific Zoho lead by ID
router.post('/lead/:id', async (req, res) => {
  if (req.headers['x-api-secret'] !== process.env.API_SECRET &&
      req.query.secret !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = await getZohoToken();
    const resp  = await axios.get(`${CRM_BASE}/Leads/${req.params.id}`, {
      params:  { fields: 'id,Full_Name,First_Name,Last_Name,Email,Phone,Mobile,Company,Description,Lead_Source,Garment_Category,Budget,Target_Market' },
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });

    const lead = resp.data?.data?.[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const phone = lead.Phone || lead.Mobile || '';
    if (!phone) return res.status(400).json({ error: 'Lead has no phone number' });

    const agentId = getAgentForPhone(phone);
    const name    = lead.Full_Name || `${lead.First_Name || ''} ${lead.Last_Name || ''}`.trim();
    const category = lead.Garment_Category || lead.Category || '';
    const segment_intel = await buildContextBlock({ category }).catch(() => '');

    await triggerCall({
      to: phone, agentId,
      variables: {
        name, email: lead.Email || '', business: lead.Company || '',
        goal: lead.Description || 'launch my fashion label',
        category, budget: lead.Budget || '', market: lead.Target_Market || '',
        source: lead.Lead_Source || 'zoho', segment_intel,
        today: new Date().toLocaleDateString('en-US', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        }),
      },
    });

    await axios.put(`${CRM_BASE}/Leads/${lead.id}`, {
      data: [{ AI_Last_Call_Status: 'triggered', AI_Last_Call_Date: new Date().toISOString().split('T')[0] }],
    }, { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' } })
      .catch(() => {});

    res.json({ triggered: true, name, phone });
  } catch (e) {
    console.error('[sync/lead]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.syncNewLeads = syncNewLeads;
