'use strict';

// Polls Zoho for leads created in the last 10 minutes that haven't been called.
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

  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const search = await axios.get(`${CRM_BASE}/Leads/search`, {
    params: {
      criteria: `((Created_Time:greater_equal:${since})and(AI_Last_Call_Status:is_null:true))`,
      fields:   'id,Full_Name,First_Name,Last_Name,Email,Phone,Mobile,Company,Description,Lead_Source,Garment_Category,Budget,Target_Market',
      per_page: 10,
    },
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  }).catch(() => ({ data: { data: [] } }));

  const leads = search.data?.data || [];
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

module.exports = router;
module.exports.syncNewLeads = syncNewLeads;
