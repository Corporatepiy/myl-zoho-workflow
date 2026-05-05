'use strict';

const axios      = require('axios');
const { CRM_BASE } = require('../config');

let _zohoToken  = null;
let _zohoExpiry = 0;

async function getZohoToken() {
  if (_zohoToken && Date.now() < _zohoExpiry) return _zohoToken;
  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token',
    },
  });
  _zohoToken  = res.data.access_token;
  _zohoExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return _zohoToken;
}

function zohoHeaders(token) {
  return { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' };
}

function splitName(fullName) {
  const [first, ...rest] = (fullName || 'Unknown').split(' ');
  return { First_Name: first, Last_Name: rest.join(' ') || 'Lead' };
}

// ─────────────────────────────────────────────
// LEADS
// ─────────────────────────────────────────────

async function createLead({ name, email, phone, business, goal, category, budget }) {
  if (process.env.SANDBOX_MODE === 'true') {
    console.log(`[SANDBOX] createLead suppressed for ${email}`);
    return;
  }
  const token = await getZohoToken();
  const { First_Name, Last_Name } = splitName(name);
  await axios.post(`${CRM_BASE}/Leads`, {
    data: [{
      First_Name,
      Last_Name,
      Email:       email,
      Phone:       phone,
      Company:     business || 'Not mentioned',
      Description: goal     || '',
      Lead_Source: 'MYL Brain',
      // Custom fields — must match your Zoho field API names
      garmentTypes:  category || '',
      budgetRange:   budget   || '',
      Lead_Status:   'Not Contacted',
    }],
  }, { headers: zohoHeaders(token) });
}

// Writes call enrichment data back to the lead after a Synthflow call ends.
// founderStage, designReadiness, validationAppetite, journeyStage are custom fields
// — verify API names match what's in your Zoho account (Settings → Fields).
async function updateLead({ email, leadScore, leadQuality, callSummary, founderStage, designReadiness, validationAppetite, journeyStageRevenue }) {
  if (!email) return;
  if (process.env.SANDBOX_MODE === 'true') {
    console.log(`[SANDBOX] updateLead suppressed for ${email}`);
    return;
  }
  const token  = await getZohoToken();
  const search = await axios.get(`${CRM_BASE}/Leads/search`, {
    params:  { criteria: `(Email:equals:${email})` },
    headers: zohoHeaders(token),
  });
  const lead = search.data?.data?.[0];
  if (!lead) {
    console.warn('[zoho] lead not found for email:', email);
    return;
  }
  await axios.put(`${CRM_BASE}/Leads/${lead.id}`, {
    data: [{
      Description:          callSummary         || '',
      Rating:               leadQuality         || '',
      Lead_Status:          founderStage === 'ONBOARDED' ? 'Qualified'
                          : (leadScore  >= 70)  ? 'Pre-Qualified'
                          :                       'Review',
      // Custom fields
      founderStage:         founderStage        || '',
      designReadiness:      designReadiness     || '',
      validationAppetite:   validationAppetite  || '',
      journeyStageRevenue:  journeyStageRevenue || '',
    }],
  }, { headers: zohoHeaders(token) });
}

// ─────────────────────────────────────────────
// DEALS — Contact info belongs on the Contact/Lead, not the Deal itself.
// We store email + phone in the Description so the team has it.
// ─────────────────────────────────────────────

async function createDeal({ name, email, phone, business, goal }) {
  if (process.env.SANDBOX_MODE === 'true') {
    console.log(`[SANDBOX] createDeal suppressed for ${email}`);
    return;
  }
  const token = await getZohoToken();
  const { First_Name, Last_Name } = splitName(name);
  await axios.post(`${CRM_BASE}/Deals`, {
    data: [{
      Deal_Name:    `${First_Name} ${Last_Name} — ${business || 'Fashion Brand'}`,
      Stage:        'Consultation Booked',
      Description:  `${goal || ''}\nContact: ${email || ''} | ${phone || ''}`.trim(),
      Closing_Date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    }],
  }, { headers: zohoHeaders(token) });
}

async function getLead(email) {
  if (!email) return null;
  const token  = await getZohoToken();
  const search = await axios.get(`${CRM_BASE}/Leads/search`, {
    params:  { criteria: `(Email:equals:${email})` },
    headers: zohoHeaders(token),
  });
  return search.data?.data?.[0] || null;
}

async function searchLeadByName(name) {
  if (!name) return null;
  const token  = await getZohoToken();
  const search = await axios.get(`${CRM_BASE}/Leads/search`, {
    params:  { criteria: `(Full_Name:contains:${name})` },
    headers: zohoHeaders(token),
  });
  return search.data?.data?.[0] || null;
}

async function addNote({ email, note }) {
  if (process.env.SANDBOX_MODE === 'true') {
    console.log(`[SANDBOX] addNote suppressed for ${email}`);
    return;
  }
  const lead = await getLead(email);
  if (!lead) throw new Error('Lead not found: ' + email);
  const token = await getZohoToken();
  await axios.post(`${CRM_BASE}/Notes`, {
    data: [{
      Note_Title:   'Co-founder note',
      Note_Content: note,
      Parent_Id:    lead.id,
      $se_module:   'Leads',
    }],
  }, { headers: zohoHeaders(token) });
}

async function addTask({ email, task, due_date }) {
  if (process.env.SANDBOX_MODE === 'true') {
    console.log(`[SANDBOX] addTask suppressed for ${email}`);
    return;
  }
  const lead = await getLead(email);
  if (!lead) throw new Error('Lead not found: ' + email);
  const token = await getZohoToken();
  await axios.post(`${CRM_BASE}/Tasks`, {
    data: [{
      Subject:    task,
      Due_Date:   due_date || new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      Status:     'Not Started',
      $se_module: 'Leads',
      What_Id:    lead.id,
    }],
  }, { headers: zohoHeaders(token) });
}

// Logs every Synthflow call as a native Zoho CRM Call activity.
// Shows up in Activities → Calls and in each lead's timeline.
// Gives the owner full call volume visibility inside Zoho (MYL Intelligence view).
async function logCall({ email, callId, durationSeconds, summary, leadScore, leadQuality, outcome }) {
  if (process.env.SANDBOX_MODE === 'true') {
    console.log(`[SANDBOX] logCall suppressed callId=${callId}`);
    return;
  }
  try {
    const token = await getZohoToken();
    const lead  = email ? await getLead(email).catch(() => null) : null;

    const mins = Math.floor((durationSeconds || 0) / 60);
    const secs = (durationSeconds || 0) % 60;
    const dur  = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;

    const record = {
      Subject:          `MYL Alex — ${leadQuality || 'Unknown'} lead (Score: ${leadScore || 0})`,
      Call_Type:        'Outbound',
      Call_Duration:    dur,
      Call_Result:      outcome === 'human_goodbye' ? 'Completed' : 'No Answer / Left Message',
      Description:      summary || '',
      Call_Purpose:     'Prospecting',
    };
    if (lead?.id) {
      record.Who_Id = { id: lead.id, module: 'Leads' };
    }

    await axios.post(`${CRM_BASE}/Calls`, { data: [record] }, { headers: zohoHeaders(token) });
  } catch (e) {
    console.warn('[zoho] logCall failed (non-fatal):', e.message);
  }
}

module.exports = { createLead, updateLead, createDeal, getLead, searchLeadByName, addNote, addTask, logCall, getZohoToken };
