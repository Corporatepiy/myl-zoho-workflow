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
  const token  = await getZohoToken();
  const search = await axios.get(`${CRM_BASE}/Leads/search`, {
    params:  { email },
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

module.exports = { createLead, updateLead, createDeal };
