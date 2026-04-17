const express = require('express');
const path = require('path');
const axios = require('axios');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Trust Railway proxy headers
app.set('trust proxy', 1);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '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';

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  synthflow: {
    apiKey:  process.env.SYNTHFLOW_API_KEY || '1mVbM6zj-79hvVKzhYxinn-Zlm9s9wca4-C9c43KgcQ',
    baseUrl: 'https://api.synthflow.ai/v2',
    // ── 4 dedicated agents — add IDs as you create them in Synthflow dashboard
    agents: {
      speedToLead:        process.env.AGENT_SPEED_TO_LEAD        || 'b81f2830-4467-4725-92d3-578ee75e11bd', // Meher — current agent
      conversionCloser:   process.env.AGENT_CONVERSION_CLOSER    || '',   // Meher — create in Synthflow
      onboarding:         process.env.AGENT_ONBOARDING           || '',   // Priya — create in Synthflow
      reengagement:       process.env.AGENT_REENGAGEMENT         || '',   // Meher — create in Synthflow
    },
  },
  zoho: {
    clientId: process.env.ZOHO_CLIENT_ID || '1000.U89IELOTL9LR9D89G9OL0BR6P4OVIG',
    clientSecret: process.env.ZOHO_CLIENT_SECRET || '4b4659f29bff6d8daf3885708d8cf8a70485eeecff',
    refreshToken: process.env.ZOHO_REFRESH_TOKEN || '1000.149cdc169aad2b1ad5df3f4bb049e6c5.684980ca9998f11acd25b3afd3ac1e20',
    accountUrl: process.env.ZOHO_ACCOUNT_URL || 'https://accounts.zoho.in',
    baseUrl: process.env.ZOHO_BASE_URL || 'https://www.zohoapis.in',
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
  },
  publicUrl: process.env.PUBLIC_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:3000'}`,
  retry: {
    maxAttempts: 3,
    delaysMinutes: [30, 60, 120],
  },
};

// ── IN-MEMORY STORES ─────────────────────────────────────────────────────────
const retryQueue = new Map();        // leadId → { attempts, timers }
const callLog = [];                  // live call log (kept for logging)
const callMonitor = new Map();       // callId → { leadId, startTime, processed }
const recentlyProcessed = new Map(); // leadId → timestamp (duplicate guard)

// ── ZOHO PICKLIST MAPPERS ─────────────────────────────────────────────────────
// Internal callStatus drives routing logic. These map to valid Zoho picklist values.
function toZohoCallStatus(callStatus) {
  const map = {
    'Consultation Booked':   'Completed',
    'Callback Requested':    'Completed',
    'Not Interested':        'Completed',
    'No Answer / Voicemail': 'No Answer',
    'Call Completed':        'Completed',
    'Busy':                  'Busy',
    'Failed':                'Failed',
    'Voicemail':             'Voicemail',
  };
  return map[callStatus] || 'Completed';
}

function toZohoBuyingIntent(rating) {
  // AI returns Hot/Warm/Cold → goes to Buying_Intent field
  if (['Hot', 'Warm', 'Cold'].includes(rating)) return rating;
  return 'Warm';
}

function toZohoRating(rating) {
  // Rating picklist: High/Medium/Low/Cold
  const map = { Hot: 'High', Warm: 'Medium', Cold: 'Low' };
  return map[rating] || 'Medium';
}

function toZohoBusinessStage(stage) {
  if (stage === 'Existing Business') return 'Existing';
  if (['Idea Stage', 'Sampling Stage'].includes(stage)) return 'Start Up';
  return null;
}

// ── ZOHO TOKEN ────────────────────────────────────────────────────────────────
let zohoAccessToken = null;
let tokenExpiry = 0;

async function getZohoToken() {
  if (zohoAccessToken && Date.now() < tokenExpiry) return zohoAccessToken;
  const res = await axios.post(`${CONFIG.zoho.accountUrl}/oauth/v2/token`, null, {
    params: {
      refresh_token: CONFIG.zoho.refreshToken,
      client_id: CONFIG.zoho.clientId,
      client_secret: CONFIG.zoho.clientSecret,
      grant_type: 'refresh_token',
    },
  });
  zohoAccessToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  console.log('[Zoho] Token refreshed');
  return zohoAccessToken;
}

// ── ZOHO LEAD FETCHER ─────────────────────────────────────────────────────────
async function fetchLead(leadId) {
  const token = await getZohoToken();
  const res = await axios.get(
    `${CONFIG.zoho.baseUrl}/crm/v2/Leads/${leadId}?fields=id,First_Name,Last_Name,Phone,Mobile,Email,Company,Lead_Source,Rating,Lead_Status,Industry,Title,City,State,Country,estimatedOrderQuantity,productionTimeline,garmentTypes,AI_Last_Call_Status,AI_Call_Duration,AI_Last_Call_Date,AI_Agent_Used,AI_Call_Retry_Count,Description`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data?.data?.[0] || null;
}

// ── ZOHO LEAD UPDATER ─────────────────────────────────────────────────────────
async function updateLead(leadId, fields) {
  const token = await getZohoToken();
  const res = await axios.put(
    `${CONFIG.zoho.baseUrl}/crm/v2/Leads/${leadId}`,
    { data: [{ id: leadId, ...fields }] },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data?.data?.[0];
}

// ── ZOHO NOTE CREATOR ─────────────────────────────────────────────────────────
async function createZohoNote(leadId, title, content) {
  try {
    const token = await getZohoToken();
    await axios.post(
      `${CONFIG.zoho.baseUrl}/crm/v2/Leads/${leadId}/Notes`,
      { data: [{ Note_Title: title, Note_Content: content, $se_module: 'Leads', Parent_Id: leadId }] },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`[Zoho] Note created for lead ${leadId}`);
  } catch (err) {
    console.error('[Zoho] Note creation failed:', err.response?.data || err.message);
  }
}

// ── ZOHO TASK CREATOR ─────────────────────────────────────────────────────────
async function createZohoTask(leadId, leadName, subject, description, dueDays = 1) {
  try {
    const token = await getZohoToken();
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + dueDays);
    const dueDateStr = dueDate.toISOString().split('T')[0];
    await axios.post(
      `${CONFIG.zoho.baseUrl}/crm/v2/Tasks`,
      { data: [{ Subject: subject, Due_Date: dueDateStr, Description: description, Status: 'Not Started', Priority: 'High', $se_module: 'Leads', What_Id: { id: leadId, name: leadName } }] },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`[Zoho] Task created: "${subject}" for lead ${leadId}`);
  } catch (err) {
    console.error('[Zoho] Task creation failed:', err.response?.data || err.message);
  }
}

// ── ZOHO EVENT/MEETING CREATOR ────────────────────────────────────────────────
function fmtBookingTime(date) {
  // Returns "dd-MMM-yyyy HH:mm:ss" in IST — required by Zoho Bookings API
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const ist = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const dd  = String(ist.getDate()).padStart(2, '0');
  const mon = MONTHS[ist.getMonth()];
  const yr  = ist.getFullYear();
  const hh  = String(ist.getHours()).padStart(2, '0');
  const mm  = String(ist.getMinutes()).padStart(2, '0');
  return `${dd}-${mon}-${yr} ${hh}:${mm}:00`;
}

async function createZohoMeeting(leadId, leadName, phone, email, startIso, summary) {
  // "Start Your Business Consultation" — has slots configured; mandatory field handled below
  const SERVICE_ID = '362812000000176120';
  const STAFF_ID   = '362812000000214048';

  const token = await getZohoToken();
  const requestedStart = new Date(startIso);
  const fmt = d => d.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace(' ', 'T') + '+05:30';

  let bookedTime = null;
  let apptId = null;

  // Mandatory checkbox field on service 1 — exact label with unicode apostrophes
  const mandatoryFieldLabel = "Our experts are senior, highly respected fashion professionals, and their time is extremely valuable. Please apply only if you are genuinely serious about building your brand.'' After booking, our team will call to confirm your attendance and verify your interest. Please let us know if you\u2019ll be joining and be available to take the call.''";
  const customerDetails = JSON.stringify({ name: leadName, email: email || '', phone_number: phone || '' });

  // Try common business hour slots across next 7 days (availableslots API unreliable with CREATE-only scope)
  const CANDIDATE_TIMES = ['10:00', '10:30', '11:00', '11:30', '14:00', '14:30', '15:00', '15:30', '09:00', '09:30', '16:00', '17:00'];

  outer:
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const checkDate = new Date(requestedStart);
    checkDate.setDate(checkDate.getDate() + dayOffset);
    const dateStr = checkDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD

    // On day 0, try the requested time first, then standard slots
    let timesToTry = [...CANDIDATE_TIMES];
    if (dayOffset === 0) {
      const reqH = String(requestedStart.getHours()).padStart(2, '0');
      const reqM = String(requestedStart.getMinutes()).padStart(2, '0');
      timesToTry = [`${reqH}:${reqM}`, ...CANDIDATE_TIMES.filter(t => t !== `${reqH}:${reqM}`)];
    }

    for (const timeSlot of timesToTry) {
      const slotDateTime = new Date(`${dateStr}T${timeSlot}:00+05:30`);
      if (slotDateTime <= new Date()) continue; // skip past times
      const fromTime = fmtBookingTime(slotDateTime);

      const additionalFields = JSON.stringify({ [mandatoryFieldLabel]: 'Yes, I confirm' });
      const params = new URLSearchParams({
        service_id:        SERVICE_ID,
        staff_id:          STAFF_ID,
        from_time:         fromTime,
        customer_details:  customerDetails,
        notes:             summary.slice(0, 500),
        additional_fields: additionalFields,
      });

      try {
        const res = await axios.post(
          'https://www.zohoapis.in/bookings/v1/json/appointment',
          params.toString(),
          { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        const rv = res.data?.response?.returnvalue;
        if (rv?.status === 'failure') {
          if (rv.message?.includes('slot not available')) {
            console.log(`[Bookings] Slot ${fromTime} not available — trying next`);
            continue; // try next time slot
          }
          console.error(`[Bookings] Booking failed: ${rv.message}`);
          break outer; // non-slot error — stop trying
        }
        apptId = rv?.id || rv?.booking_id;
        bookedTime = slotDateTime;
        console.log(`[Bookings] Appointment created for ${leadName} at ${fromTime} — ID: ${apptId}`);
        if (email) console.log(`[Bookings] Confirmation email sent to ${email}`);
        break outer;
      } catch (bookErr) {
        console.error(`[Bookings] Request error for ${fromTime}:`, bookErr.response?.data || bookErr.message);
        break outer;
      }
    }
  }

  if (!bookedTime) {
    console.warn(`[Bookings] No available slot found — CRM Event created only`);
  }

  if (!bookedTime) {
    console.warn(`[Bookings] Could not find an available slot in next 7 days — using CRM Event only`);
  }

  // Always create CRM Event for lead timeline visibility
  try {
    const eventStart = bookedTime || requestedStart;
    const eventEnd   = new Date(eventStart.getTime() + 30 * 60 * 1000);
    await axios.post(
      `${CONFIG.zoho.baseUrl}/crm/v2/Events`,
      { data: [{ Event_Title: `MYL Consultation — ${leadName}`, Start_DateTime: fmt(eventStart), End_DateTime: fmt(eventEnd), Description: summary, Location: 'Google Meet / Phone Call', $se_module: 'Leads', What_Id: { id: leadId, name: leadName } }] },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`[Zoho] CRM Event created for ${leadName}`);
  } catch (evtErr) {
    console.error('[Zoho] CRM Event creation failed:', evtErr.response?.data || evtErr.message);
  }

  return apptId;
}

// ── ZOHO CALL LOG ─────────────────────────────────────────────────────────────
async function logZohoCall(leadId, leadName, phone, durationSec, description, callStatus) {
  try {
    const token = await getZohoToken();
    const callTime = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace(' ', 'T') + '+05:30';
    await axios.post(
      `${CONFIG.zoho.baseUrl}/crm/v2/Calls`,
      { data: [{ Subject: `AI Outbound Call — ${callStatus}`, Call_Type: 'Outbound', Call_Start_Time: callTime, Duration_Min_Sec: `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, '0')}`, Call_Result: callStatus, Description: description, $se_module: 'Leads', What_Id: { id: leadId, name: leadName }, Who_Id: { id: leadId, name: leadName } }] },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`[Zoho] Call logged for lead ${leadId}`);
  } catch (err) {
    console.error('[Zoho] Call log failed:', err.response?.data || err.message);
  }
}

// ── AGENT SELECTOR — pick the right Synthflow agent for each use case ─────────
function selectAgent(lead, forceType) {
  // forceType overrides everything (used by dedicated webhook routes)
  if (forceType) return { type: forceType, id: CONFIG.synthflow.agents[forceType] || CONFIG.synthflow.agents.speedToLead };

  // Auto-select based on lead state
  if (lead.Payment_Secured)                          return { type: 'onboarding',       id: CONFIG.synthflow.agents.onboarding };
  if (lead.Lead_Status === 'Pre-Qualified')           return { type: 'conversionCloser', id: CONFIG.synthflow.agents.conversionCloser };
  if (lead.Lead_Status === 'Contact in Future')       return { type: 'reengagement',     id: CONFIG.synthflow.agents.reengagement };
  if ((lead.AI_Call_Retry_Count || 0) >= 3)          return { type: 'reengagement',     id: CONFIG.synthflow.agents.reengagement };

  // Default: speed to lead
  return { type: 'speedToLead', id: CONFIG.synthflow.agents.speedToLead };
}

// Zoho AI_Agent_Used picklist value per agent type
const AGENT_ZOHO_VALUE = {
  speedToLead:      'Agent1-SpeedToLead',
  conversionCloser: 'Agent2-ConversionCloser',
  onboarding:       'Agent3-Onboarding',
  reengagement:     'Agent4-Reengagement',
};

// ── SYNTHFLOW CALL TRIGGER ────────────────────────────────────────────────────
async function triggerCall(lead, forceAgentType) {
  const firstName = lead.First_Name || 'there';
  const isRetry = (lead.AI_Call_Retry_Count || 0) > 0;
  const previousStatus = lead.AI_Last_Call_Status || '';
  const agent = selectAgent(lead, forceAgentType);

  if (!agent.id) {
    console.warn(`[Trigger] Agent "${agent.type}" has no ID configured yet — using SpeedToLead fallback`);
    agent.id = CONFIG.synthflow.agents.speedToLead;
  }

  // Build call context — shared across all agents, each uses what's relevant
  let callContext = `Lead name: ${firstName}.`;
  if (lead.Company)                callContext += ` Brand: "${lead.Company}".`;
  if (lead.Lead_Source)            callContext += ` Source: ${lead.Lead_Source}.`;
  if (lead.garmentTypes)           callContext += ` Garments: ${lead.garmentTypes}.`;
  if (lead.estimatedOrderQuantity) callContext += ` Est. MOQ: ${lead.estimatedOrderQuantity}.`;
  if (lead.productionTimeline)     callContext += ` Timeline: ${lead.productionTimeline}.`;
  if (lead.Buying_Intent === 'Hot')callContext += ` HOT lead — strong intent. Push for commitment.`;
  if (lead.Business_Stage)         callContext += ` Stage: ${lead.Business_Stage}.`;
  if (lead.Payment_Secured)        callContext += ` PAID CLIENT — they have paid the commitment deposit. This is an onboarding call.`;
  if (isRetry)                     callContext += ` Retry attempt ${lead.AI_Call_Retry_Count} — be brief, acknowledge previous attempts.`;
  if (previousStatus === 'Callback Requested') callContext += ` They requested a callback — acknowledge this.`;

  const res = await axios.post(
    `${CONFIG.synthflow.baseUrl}/calls`,
    {
      model_id: agent.id,
      phone:    lead.Phone || lead.Mobile,
      name:     firstName,
      custom_variables: [
        { key: 'lead_id',             value: String(lead.id) },
        { key: 'lead_name',           value: firstName },
        { key: 'lead_email',          value: lead.Email || '' },
        { key: 'lead_company',        value: lead.Company || '' },
        { key: 'lead_source',         value: lead.Lead_Source || '' },
        { key: 'buying_intent',       value: lead.Buying_Intent || 'Warm' },
        { key: 'business_stage',      value: lead.Business_Stage || '' },
        { key: 'garment_types',       value: lead.garmentTypes || '' },
        { key: 'order_quantity',      value: String(lead.estimatedOrderQuantity || '') },
        { key: 'production_timeline', value: lead.productionTimeline || '' },
        { key: 'call_context',        value: callContext },
        { key: 'agent_type',          value: agent.type },
        { key: 'is_retry',            value: isRetry ? 'true' : 'false' },
        { key: 'previous_status',     value: previousStatus },
      ],
    },
    { headers: { Authorization: `Bearer ${CONFIG.synthflow.apiKey}` } }
  );

  const callId = res.data.response?.call_id || res.data._id;
  if (callId) {
    callMonitor.set(callId, { leadId: lead.id, agentType: agent.type, startTime: Date.now(), processed: false });
    console.log(`[Monitor] Watching call ${callId} | lead ${lead.id} | agent: ${agent.type}`);
  }
  return { callId, agentType: agent.type, agentZohoValue: AGENT_ZOHO_VALUE[agent.type] };
}

// ── CALL POLLER (auto-process when Synthflow webhook doesn't fire) ─────────────
async function pollActiveCalls() {
  for (const [callId, state] of callMonitor.entries()) {
    if (state.processed) { callMonitor.delete(callId); continue; }
    const ageMin = (Date.now() - state.startTime) / 60000;
    if (ageMin > 60) { callMonitor.delete(callId); continue; } // abandon after 60 min

    try {
      const r = await axios.get(`${CONFIG.synthflow.baseUrl}/calls/${callId}`,
        { headers: { Authorization: `Bearer ${CONFIG.synthflow.apiKey}` } });
      const call = r.data.response?.calls?.[0];
      if (!call || !call.end_call_reason || call.duration === 0) continue; // still in progress

      state.processed = true;
      console.log(`[Monitor] Call ${callId} completed (${call.duration}s) — auto-processing`);

      // Fire the same processing logic as the webhook route
      await processCompletedCall({ call_id: callId, duration: call.duration, end_call_reason: call.end_call_reason, transcript: call.transcript || '', prompt_variables: { lead_id: state.leadId } });
    } catch (err) {
      console.error(`[Monitor] Poll error for ${callId}:`, err.message);
    }
  }
}
setInterval(pollActiveCalls, 30 * 1000); // check every 30 seconds

// ── SHARED POST-CALL PROCESSOR ────────────────────────────────────────────────
async function processCompletedCall(call) {
  const leadId = call.prompt_variables?.lead_id;
  if (!leadId) return;

  // ── Duplicate guard — skip if same lead processed in last 10 minutes ──────
  const lastProcessed = recentlyProcessed.get(leadId);
  if (lastProcessed && Date.now() - lastProcessed < 10 * 60 * 1000) {
    console.log(`[Lead ${leadId}] Duplicate — already processed ${Math.round((Date.now() - lastProcessed) / 1000)}s ago — skipping`);
    return;
  }
  recentlyProcessed.set(leadId, Date.now());

  const durationSec = call.duration || 0;
  const transcript  = call.transcript || '';
  const intel = await analyzeTranscript(transcript, durationSec);
  const { callStatus, leadStatus, rating, industry, annualRevenue, employees, email, company, title, city, meetingDateTime, meetingNotes, nextSteps, description } = intel;

  console.log(`[Lead ${leadId}] Call ended — status: ${callStatus}, rating: ${rating}, duration: ${durationSec}s`);

  const zohoUpdate = {
    AI_Last_Call_Status: toZohoCallStatus(callStatus),   // valid picklist: Completed/No Answer/Busy/Failed/Voicemail
    AI_Call_Duration:    Math.round(durationSec),
    AI_Last_Call_Date:   new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace(' ', 'T') + '+05:30',
    AI_Agent_Used:       'Agent1-SpeedToLead',            // valid picklist value
    Buying_Intent:       toZohoBuyingIntent(rating),      // Hot/Warm/Cold → correct field
    Rating:              toZohoRating(rating),             // High/Medium/Low/Cold → correct field
    Lead_Status:         ['Pre-Qualified','Contacted','Attempted to Contact','Not Qualified','Lost Lead','Contact in Future'].includes(leadStatus) ? leadStatus : 'Contacted',
    Description:         description,
  };
  const bizStage = toZohoBusinessStage(intel.stage);
  if (bizStage)      zohoUpdate.Business_Stage = bizStage;   // Start Up / Existing
  if (industry)      zohoUpdate.Industry = industry;
  if (annualRevenue) zohoUpdate.Annual_Revenue = annualRevenue;
  if (employees)     zohoUpdate.No_of_Employees = employees;
  if (email)         zohoUpdate.Email = email;
  if (company)       zohoUpdate.Company = company;
  if (title)         zohoUpdate.Title = title;
  if (city)          zohoUpdate.City = city;
  await updateLead(leadId, zohoUpdate);

  const lead = await fetchLead(leadId);
  const leadName = `${lead?.First_Name || ''} ${lead?.Last_Name || ''}`.trim() || 'Lead';
  const leadPhone = lead?.Phone || lead?.Mobile || '';

  await logZohoCall(leadId, leadName, leadPhone, Math.round(durationSec), description, callStatus);

  const noteDate = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  await createZohoNote(leadId, `AI Call Notes — ${noteDate}`, description);

  if (callStatus !== 'Not Interested') {
    const taskSubjects = {
      'Consultation Booked':   `Send consultation confirmation to ${leadName}`,
      'Callback Requested':    `Call back ${leadName} — requested during AI call`,
      'Call Completed':        `Follow up with ${leadName} — send catalogue`,
      'No Answer / Voicemail': `Retry call to ${leadName}`,
    };
    const taskDays = callStatus === 'Consultation Booked' ? 1 : callStatus === 'Callback Requested' ? 1 : 2;
    await createZohoTask(leadId, leadName, taskSubjects[callStatus] || `Follow up with ${leadName}`, nextSteps || description.slice(0, 300), taskDays);
  }

  if (callStatus === 'Consultation Booked') {
    let meetingIso = meetingDateTime;
    if (!meetingIso) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(10, 0, 0, 0);
      meetingIso = tomorrow.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace(' ', 'T') + '+05:30';
    }
    await createZohoMeeting(leadId, leadName, leadPhone, email || lead?.Email || '', meetingIso,
      `Consultation booked via AI call.\n\n${meetingNotes || ''}\n\nLead Summary:\n${description.split('━━━ FULL TRANSCRIPT')[0]}`);
  }

  logCall({ leadId, callId: call.call_id, status: callStatus, duration: durationSec, transcript: transcript.slice(0, 200) });

  if (lead && leadPhone) await sendSMS(leadPhone, getSMSMessage(callStatus, lead));

  if (callStatus === 'No Answer / Voicemail' && lead) scheduleRetry(lead);
  else retryQueue.delete(leadId);

  return { callStatus, meetingBooked: !!meetingDateTime };
}

// ── SMS SENDER ────────────────────────────────────────────────────────────────
async function sendSMS(to, message) {
  if (!CONFIG.twilio.accountSid || !CONFIG.twilio.authToken || !CONFIG.twilio.fromNumber) {
    console.log(`[SMS] Twilio not configured — would send to ${to}: "${message}"`);
    return { simulated: true };
  }
  const twilio = require('twilio')(CONFIG.twilio.accountSid, CONFIG.twilio.authToken);
  const msg = await twilio.messages.create({ body: message, from: CONFIG.twilio.fromNumber, to });
  console.log(`[SMS] Sent to ${to} — SID: ${msg.sid}`);
  return msg;
}

// ── SMS TEMPLATES ─────────────────────────────────────────────────────────────
function getSMSMessage(callStatus, lead) {
  const name = lead.First_Name || 'there';
  const templates = {
    'Consultation Booked':
      `Hi ${name}! This is Alex from MakeYourLabel. Great speaking with you! Your consultation is confirmed. We'll send calendar details shortly. Questions? Reply here or visit makeyourlabel.com`,
    'Callback Requested':
      `Hi ${name}, Alex from MakeYourLabel here. You asked me to call back — I'll reach you at the time we agreed. Meanwhile, explore what we offer: makeyourlabel.com`,
    'Not Interested':
      `Hi ${name}, Alex from MakeYourLabel. Totally respect your decision. When you're ready to launch your brand, we're here. makeyourlabel.com — no pressure, ever.`,
    'No Answer / Voicemail':
      `Hi ${name}! Alex from MakeYourLabel — tried reaching you about launching your clothing brand. We help brands go from idea to product fast. Call back: +18554495332 or visit launch.makeyourlabel.com`,
    'Completed':
      `Hi ${name}, thanks for speaking with Alex from MakeYourLabel! Next steps are at launch.makeyourlabel.com. Any questions, just reply here.`,
  };
  return templates[callStatus] || templates['Completed'];
}

// ── RETRY SCHEDULER ───────────────────────────────────────────────────────────
function scheduleRetry(lead) {
  const leadId = lead.id;
  if (!retryQueue.has(leadId)) retryQueue.set(leadId, { attempts: 0 });
  const state = retryQueue.get(leadId);

  if (state.attempts >= CONFIG.retry.maxAttempts) {
    console.log(`[Retry] Lead ${leadId} hit max attempts (${CONFIG.retry.maxAttempts}) — moving to Contact in Future`);
    updateLead(leadId, {
      AI_Last_Call_Status: 'No Answer',           // valid picklist
      Lead_Status: 'Contact in Future',            // valid picklist
    }).catch(() => {});
    retryQueue.delete(leadId);
    return;
  }

  const delayMin = CONFIG.retry.delaysMinutes[state.attempts] || 120;
  state.attempts += 1;
  console.log(`[Retry] Lead ${leadId} — attempt ${state.attempts}/${CONFIG.retry.maxAttempts} in ${delayMin} min`);

  const timer = setTimeout(async () => {
    try {
      console.log(`[Retry] Firing attempt ${state.attempts} for lead ${leadId}`);
      const freshLead = await fetchLead(leadId);
      if (!freshLead) return;

      const { callId, agentZohoValue } = await triggerCall(freshLead, 'reengagement');
      logCall({ leadId, name: `${freshLead.First_Name} ${freshLead.Last_Name}`, phone: freshLead.Phone, callId, status: 'Retry', attempt: state.attempts });

      await updateLead(leadId, {
        AI_Last_Call_Status: 'No Answer',
        AI_Agent_Used:       agentZohoValue,
        AI_Last_Call_Date:   new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace(' ', 'T') + '+05:30',
        AI_Call_Retry_Count: state.attempts,
      });
    } catch (err) {
      console.error(`[Retry] Error on attempt ${state.attempts} for ${leadId}:`, err.message);
    }
  }, delayMin * 60 * 1000);

  state.timer = timer;
}

// ── CALL LOG ──────────────────────────────────────────────────────────────────
function logCall(entry) {
  callLog.unshift({ ...entry, timestamp: new Date().toISOString() });
  if (callLog.length > 200) callLog.pop();
}

// ── ROUTE 1: Zoho → Synthflow (new lead) ─────────────────────────────────────
app.post('/zoho/new-lead', async (req, res) => {
  try {
    console.log('[Webhook] Payload:', JSON.stringify(req.body));

    let leads = [];
    if (req.body?.ids) {
      for (const id of req.body.ids) {
        const l = await fetchLead(id);
        if (l) leads.push(l);
      }
    } else if (req.body?.data) {
      leads = req.body.data;
    } else {
      leads = req.body?.leads || [req.body];
    }

    for (const lead of leads) {
      const phone = lead.Phone || lead.Mobile;
      const name = `${lead.First_Name || ''} ${lead.Last_Name || ''}`.trim() || 'Lead';
      const leadId = lead.id;

      if (!phone) { console.log(`[Lead ${leadId}] No phone — skipping`); continue; }

      // ── Block CallHippo ghost leads (inbound missed calls with no name/email/source)
      const isGhost = !lead.First_Name && !lead.Email && !lead.Lead_Source;
      if (isGhost) {
        console.log(`[Lead ${leadId}] Ghost lead (no name/email/source — likely CallHippo missed call) — creating callback task, skipping AI call`);
        await createZohoTask(leadId, name, `Call back inbound caller — ${phone}`, `Missed inbound call. No form submission. Verify before calling.`, 0);
        continue;
      }

      const isLandingPage = (lead.Lead_Source || '').toLowerCase().includes('landing');
      const forceAgent = isLandingPage ? 'landingPage' : undefined;
      console.log(`[Lead ${leadId}] Triggering call to ${phone} for ${name} | agent: ${forceAgent || 'auto'}`);
      const { callId, agentZohoValue } = await triggerCall(lead, forceAgent);
      logCall({ leadId, name, phone, callId, status: 'Call Initiated', attempt: 1 });
      console.log(`[Lead ${leadId}] Call triggered — call_id: ${callId} | agent: ${agentZohoValue}`);

      await updateLead(leadId, {
        AI_Last_Call_Date:   new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace(' ', 'T') + '+05:30',
        AI_Agent_Used:       agentZohoValue,
        AI_Call_Retry_Count: 0,
        Lead_Status:         'Attempted to Contact',
      });
    }

    res.json({ status: 'ok', message: 'Calls triggered' });
  } catch (err) {
    console.error('[/zoho/new-lead] Error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── TRANSCRIPT INTELLIGENCE (Claude AI) ──────────────────────────────────────
async function analyzeTranscript(transcript, durationSec) {
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const mins = Math.floor(durationSec / 60);
  const secs = durationSec % 60;

  // Fallback defaults if AI call fails
  const fallback = {
    callStatus: durationSec < 15 ? 'No Answer / Voicemail' : 'Call Completed',
    leadStatus: durationSec < 15 ? 'Attempted to Contact' : 'Contacted',
    rating: 'Warm', industry: null, annualRevenue: null, employees: null,
    email: null, company: null, productInterest: 'General Apparel',
    stage: 'Unknown', nextSteps: 'Follow up required', summary: '',
  };

  try {
    const todayIso = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace(' ', 'T') + '+05:30';
    const prompt = `You are a CRM data extraction assistant for MakeYourLabel, a custom clothing manufacturing company in India.

Analyze this sales call transcript and extract structured data. Return ONLY valid JSON, no explanation.

Today's date/time: ${todayIso} (IST)
Call duration: ${durationSec} seconds
Transcript:
${transcript}

Return this exact JSON structure:
{
  "callStatus": "one of: Consultation Booked | Callback Requested | Not Interested | No Answer / Voicemail | Call Completed",
  "leadStatus": "one of: Pre-Qualified | Contacted | Attempted to Contact | Not Qualified | Lost Lead",
  "rating": "one of: Hot | Warm | Cold",
  "industry": "Zoho industry value or null (e.g. Apparel & Fashion, Sporting Goods, Retail)",
  "annualRevenue": number or null (budget in INR — convert lakhs/crores to full number),
  "employees": number or null (team size if mentioned),
  "email": "email if shared during call or null",
  "company": "brand or company name if mentioned or null",
  "title": "lead's job title or role if mentioned or null",
  "city": "city if mentioned or null",
  "productInterest": "short phrase e.g. Streetwear, Activewear, Uniforms, Kids Wear, General Apparel",
  "stage": "one of: Idea Stage | Sampling Stage | Existing Business | Unknown (Idea Stage and Sampling Stage both map to Start Up brand; Existing Business means they already sell clothing)",
  "meetingDateTime": "ISO 8601 datetime in IST (+05:30) if a specific meeting time was agreed upon, else null. Infer from relative mentions like 'tomorrow 3pm', 'Thursday afternoon' using today's date.",
  "meetingNotes": "what was agreed about the meeting (location, topic, who joins) or null",
  "objections": "key objections the lead raised or null",
  "painPoints": "main challenges the lead mentioned (e.g. no designer, low budget, tight timeline) or null",
  "nextSteps": "one clear action sentence for the sales team",
  "summary": "3-5 sentence human summary: who they are, what they want, how the call went, any agreed actions, what happens next"
}`;

    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }, {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    });

    const raw = res.data.content[0].text.trim();
    const json = JSON.parse(raw.replace(/^```json\n?|\n?```$/g, ''));

    const description = [
      `━━━ AI CALL SUMMARY ━━━`,
      `Date: ${now} IST | Duration: ${mins}m ${secs}s | Agent: Alex (MYL Onboarding)`,
      `Outcome: ${json.callStatus} | Rating: ${json.rating}`,
      ``,
      `SUMMARY:`,
      json.summary,
      ``,
      `LEAD DETAILS:`,
      `• Product Interest: ${json.productInterest || 'General Apparel'}`,
      `• Business Stage: ${json.stage}`,
      json.industry   ? `• Industry: ${json.industry}` : null,
      json.annualRevenue ? `• Budget: ₹${Number(json.annualRevenue).toLocaleString('en-IN')}` : null,
      json.employees  ? `• Team Size: ${json.employees} people` : null,
      json.company    ? `• Brand Name: ${json.company}` : null,
      json.title      ? `• Role/Title: ${json.title}` : null,
      json.city       ? `• City: ${json.city}` : null,
      json.painPoints ? `• Pain Points: ${json.painPoints}` : null,
      json.objections ? `• Objections: ${json.objections}` : null,
      json.meetingDateTime ? `• Meeting Booked: ${json.meetingDateTime}` : null,
      json.meetingNotes    ? `• Meeting Notes: ${json.meetingNotes}` : null,
      ``,
      `NEXT STEPS:`,
      `• ${json.nextSteps}`,
      ``,
      `━━━ FULL TRANSCRIPT ━━━`,
      transcript,
    ].filter(Boolean).join('\n');

    console.log(`[AI] Transcript analyzed — status: ${json.callStatus}, rating: ${json.rating}`);
    return { ...json, description };

  } catch (err) {
    console.error('[AI] Transcript analysis failed, using fallback:', err.response?.data?.error?.message || err.message);
    fallback.description = [
      `━━━ CALL SUMMARY ━━━`,
      `Date: ${now} IST | Duration: ${mins}m ${secs}s | Agent: Alex (MYL Onboarding)`,
      `Outcome: ${fallback.callStatus}`,
      ``,
      `━━━ FULL TRANSCRIPT ━━━`,
      transcript,
    ].join('\n');
    return fallback;
  }
}

// ── ROUTE 2: Synthflow → Zoho (call completed webhook — backup) ──────────────
app.post('/synthflow/call-completed', async (req, res) => {
  try {
    const call = req.body;
    const leadId = call.prompt_variables?.lead_id || call.custom_variables?.lead_id;
    if (!leadId) return res.json({ status: 'ok', skipped: true });

    // Mark as processed so poller doesn't double-process
    if (call.call_id) {
      const mon = callMonitor.get(call.call_id);
      if (mon) mon.processed = true;
    }

    const result = await processCompletedCall(call);
    res.json({ status: 'ok', lead_id: leadId, ...result });
  } catch (err) {
    console.error('[/synthflow/call-completed] Error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ROUTE 3: OAuth Callback ───────────────────────────────────────────────────
app.get('/oauth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>OAuth Error: ${error}</h2>`);
  if (!code) return res.send('<h2>No code received</h2>');
  try {
    const tokenRes = await axios.post(`${CONFIG.zoho.accountUrl}/oauth/v2/token`, null, {
      params: { code, client_id: CONFIG.zoho.clientId, client_secret: CONFIG.zoho.clientSecret, redirect_uri: 'http://localhost:3000/oauth/callback', grant_type: 'authorization_code' },
    });
    const { access_token, refresh_token } = tokenRes.data;
    console.log('[OAuth] access_token:', access_token);
    console.log('[OAuth] refresh_token:', refresh_token);
    await setupZohoSubscription(access_token);
    res.send(`<h2>✅ Connected! Webhook active.</h2><p>Refresh Token: ${refresh_token}</p>`);
  } catch (err) {
    res.send(`<h2>Error</h2><pre>${JSON.stringify(err.response?.data || err.message)}</pre>`);
  }
});

// ── ROUTE 4: Manual Call Trigger ─────────────────────────────────────────────
app.post('/api/lead/:id/call', async (req, res) => {
  try {
    const lead = await fetchLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const { callId, agentZohoValue } = await triggerCall(lead);
    logCall({ leadId: lead.id, name: `${lead.First_Name} ${lead.Last_Name}`, phone: lead.Phone, callId, status: 'Manual Call', attempt: 1 });
    await updateLead(lead.id, { AI_Agent_Used: agentZohoValue, AI_Last_Call_Date: new Date().toISOString(), Lead_Status: 'Attempted to Contact' });
    res.json({ status: 'ok', callId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SYNTHFLOW AGENT SYNC ──────────────────────────────────────────────────────
async function updateSynthflowWebhook(tunnelUrl) {
  try {
    await axios.put(
      `${CONFIG.synthflow.baseUrl}/assistants/${CONFIG.synthflow.agentId}`,
      {
        external_webhook_url: `${tunnelUrl}/synthflow/call-completed`,
        // Fix timezone — was Europe/Berlin which confused the agent about times
        timezone: 'Asia/Kolkata',
        // Enable voicemail so unanswered calls leave a message
        voicemail_message: {
          enabled: true,
          mode: 'exact_message',
          exact_message: "Hey, it's Alex from MakeYourLabel! I tried reaching you about launching your clothing brand. We help founders go from idea to product fast — low minimums, premium quality. Give us a call back or visit makeyourlabel.com. Talk soon!",
        },
      },
      { headers: { Authorization: `Bearer ${CONFIG.synthflow.apiKey}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[Synthflow] Agent synced — webhook → ${tunnelUrl}/synthflow/call-completed | timezone: Asia/Kolkata | voicemail: enabled`);
  } catch (err) {
    console.error('[Synthflow] Agent sync error:', err.response?.data || err.message);
  }
}

// ── ZOHO SUBSCRIPTION ─────────────────────────────────────────────────────────
async function setupZohoSubscription(token) {
  try {
    const t = token || (await getZohoToken());
    const res = await axios.post(
      `${CONFIG.zoho.baseUrl}/crm/v2/actions/watch`,
      { watch: [{ channel_id: '1000000068001', events: ['Leads.create'], token: 'myl_synthflow_secret', notify_url: `${CONFIG.publicUrl}/zoho/new-lead`, channel_expiry: '2027-12-31T00:00:00+05:30' }] },
      { headers: { Authorization: `Bearer ${t}` } }
    );
    const status = res.data?.watch?.[0]?.code;
    console.log(`[Zoho] Subscription — ${status}`);
  } catch (err) {
    console.error('[Zoho] Subscription error:', err.response?.data || err.message);
  }
}

// Renew Zoho subscription every 50 minutes
setInterval(setupZohoSubscription, 50 * 60 * 1000);

// ── STARTUP INIT ──────────────────────────────────────────────────────────────
async function onStartup() {
  console.log(`[Startup] Public URL → ${CONFIG.publicUrl}`);
  await setupZohoSubscription();
  await updateSynthflowWebhook(CONFIG.publicUrl);
}

// ── TEST BOOKING ──────────────────────────────────────────────────────────────
app.post('/test/booking', async (req, res) => {
  try {
    const { lead_id, name, phone, email } = req.body;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);
    const startIso = tomorrow.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace(' ', 'T') + '+05:30';
    const apptId = await createZohoMeeting(lead_id || 'TEST', name || 'Test Lead', phone || '+919999999999', email || 'test@example.com', startIso, 'Test booking via API');
    res.json({ status: 'ok', apptId, startIso });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), retryQueue: retryQueue.size, tunnel: CONFIG.publicUrl }));

// ── DASHBOARD DATA AGGREGATOR ─────────────────────────────────────────────────
async function getDashboardData() {
  const token = await getZohoToken();
  let leads = [];
  let page = 1, hasMore = true;
  while (hasMore && page <= 5) {
    const r = await axios.get(
      `${CONFIG.zoho.baseUrl}/crm/v2/Leads?fields=id,First_Name,Last_Name,Phone,Email,Company,Lead_Source,Rating,Lead_Status,AI_Last_Call_Status,AI_Call_Duration,AI_Last_Call_Date,AI_Agent_Used,AI_Call_Retry_Count,Created_Time&page=${page}&per_page=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = r.data?.data || [];
    leads = leads.concat(data);
    hasMore = r.data?.info?.more_records || false;
    page++;
  }

  const now = new Date();
  const toIST = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const today = toIST(now);
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now); d.setDate(d.getDate() - (6 - i)); return toIST(d);
  });

  const statusCounts = {}, intentCounts = { Hot: 0, Warm: 0, Cold: 0 }, sourceCounts = {};
  const dailyCalls = Object.fromEntries(last7.map(d => [d, 0]));
  let totalCalled = 0, callsToday = 0, consultationsBooked = 0, converted = 0;
  let totalDuration = 0, callsWithDuration = 0, totalRetries = 0;

  leads.forEach(l => {
    const s = l.AI_Last_Call_Status;
    if (s) { statusCounts[s] = (statusCounts[s] || 0) + 1; totalCalled++; }
    // Use Buying_Intent (Hot/Warm/Cold) — correct field, not Rating
    const intent = l.Buying_Intent || (l.Rating === 'High' ? 'Hot' : l.Rating === 'Medium' ? 'Warm' : 'Cold');
    if (intentCounts[intent] !== undefined) intentCounts[intent]++;
    const src = l.Lead_Source || 'Direct';
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
    if (l.AI_Last_Call_Date) {
      const d = l.AI_Last_Call_Date.split('T')[0];
      if (dailyCalls[d] !== undefined) dailyCalls[d]++;
      if (d === today) callsToday++;
    }
    // Consultation booked = AI_Last_Call_Status Completed + Lead_Status Pre-Qualified
    if (s === 'Completed' && l.Lead_Status === 'Pre-Qualified') consultationsBooked++;
    if (l.Lead_Status === 'Completed') converted++;
    if (l.AI_Call_Duration > 0) { totalDuration += l.AI_Call_Duration; callsWithDuration++; }
    if (l.AI_Call_Retry_Count > 0) totalRetries += l.AI_Call_Retry_Count;
  });

  const avgDuration = callsWithDuration > 0 ? Math.round(totalDuration / callsWithDuration) : 0;
  // Connected = any call that got a Completed result (covers all positive outcomes)
  const connected = statusCounts['Completed'] || 0;

  // Recent leads table (last 15 called)
  const recentLeads = leads
    .filter(l => l.AI_Last_Call_Status)
    .sort((a, b) => new Date(b.AI_Last_Call_Date || 0) - new Date(a.AI_Last_Call_Date || 0))
    .slice(0, 15)
    .map(l => ({
      name: `${l.First_Name || ''} ${l.Last_Name || ''}`.trim() || 'Unknown',
      company: l.Company || '—',
      status: l.AI_Last_Call_Status,
      rating: l.Rating || 'Warm',
      duration: l.AI_Call_Duration || 0,
      retries: l.AI_Call_Retry_Count || 0,
      date: l.AI_Last_Call_Date ? new Date(l.AI_Last_Call_Date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—',
      source: l.Lead_Source || '—',
    }));

  const activeCalls = Array.from(callMonitor.entries())
    .filter(([, s]) => !s.processed)
    .map(([callId, s]) => ({ callId: callId.slice(-8), leadId: s.leadId, ageMin: Math.round((Date.now() - s.startTime) / 60000) }));

  return {
    kpis: { totalLeads: leads.length, totalCalled, callsToday, consultationsBooked, converted,
      hotLeads: intentCounts.Hot, avgDuration, retryQueue: retryQueue.size, totalRetries,
      successRate: totalCalled > 0 ? Math.round((consultationsBooked / totalCalled) * 100) : 0,
      connectRate: totalCalled > 0 ? Math.round((connected / totalCalled) * 100) : 0,
    },
    charts: {
      statusCounts,
      intentCounts,
      sourceCounts,
      daily: { labels: last7.map(d => new Date(d + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })), values: last7.map(d => dailyCalls[d]) },
    },
    funnel: { 'Total Leads': leads.length, 'AI Called': totalCalled, 'Connected': connected, 'Consultation Booked': consultationsBooked, 'Converted': converted },
    recentLeads,
    activeCalls,
    retryQueue: Array.from(retryQueue.entries()).map(([id, s]) => ({ leadId: id, attempts: s.attempts })),
    lastUpdated: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST',
    tunnel: CONFIG.publicUrl,
  };
}

app.get('/api/dashboard-data', async (req, res) => {
  try { res.json(await getDashboardData()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/dashboard', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MYL AI Command Center</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0b0d14;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
.header{background:linear-gradient(135deg,#1a1d2e,#12151f);border-bottom:1px solid #2a2d3e;padding:18px 28px;display:flex;align-items:center;justify-content:space-between}
.header h1{font-size:1.4rem;font-weight:700;letter-spacing:.5px}
.header h1 span{color:#6366f1}
.badge{background:#1e2035;border:1px solid #3730a3;color:#818cf8;font-size:.72rem;padding:4px 10px;border-radius:20px;display:flex;align-items:center;gap:6px}
.dot{width:7px;height:7px;border-radius:50%;background:#22c55e;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.container{padding:22px 28px;max-width:1600px;margin:0 auto}
.section-title{font-size:.7rem;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#64748b;margin-bottom:14px;margin-top:28px}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px}
.kpi{background:#13162080;border:1px solid #1e2235;border-radius:12px;padding:18px;transition:.2s}
.kpi:hover{border-color:#3730a3;transform:translateY(-2px)}
.kpi-label{font-size:.7rem;color:#64748b;font-weight:600;letter-spacing:.8px;text-transform:uppercase;margin-bottom:8px}
.kpi-value{font-size:2rem;font-weight:800;line-height:1}
.kpi-sub{font-size:.72rem;color:#64748b;margin-top:6px}
.kpi.purple .kpi-value{color:#a78bfa}
.kpi.green .kpi-value{color:#34d399}
.kpi.blue .kpi-value{color:#60a5fa}
.kpi.orange .kpi-value{color:#fb923c}
.kpi.red .kpi-value{color:#f87171}
.kpi.yellow .kpi-value{color:#fbbf24}
.charts-grid{display:grid;grid-template-columns:1fr 1.6fr 1fr;gap:16px}
.chart-card{background:#13162080;border:1px solid #1e2235;border-radius:12px;padding:20px}
.chart-card h3{font-size:.75rem;font-weight:600;color:#94a3b8;letter-spacing:.8px;text-transform:uppercase;margin-bottom:16px}
.chart-wrap{position:relative;height:200px}
.funnel-row{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.funnel-label{font-size:.78rem;color:#94a3b8;width:160px;text-align:right;flex-shrink:0}
.funnel-bar-wrap{flex:1;background:#1e2235;border-radius:6px;height:28px;position:relative;overflow:hidden}
.funnel-bar{height:100%;border-radius:6px;background:linear-gradient(90deg,#4f46e5,#7c3aed);transition:width 1s ease;display:flex;align-items:center;justify-content:flex-end;padding-right:10px}
.funnel-bar span{font-size:.75rem;font-weight:700;color:#fff;white-space:nowrap}
.funnel-pct{font-size:.72rem;color:#64748b;width:46px}
.table-card{background:#13162080;border:1px solid #1e2235;border-radius:12px;overflow:hidden;margin-top:16px}
.table-card h3{font-size:.75rem;font-weight:600;color:#94a3b8;letter-spacing:.8px;text-transform:uppercase;padding:16px 20px;border-bottom:1px solid #1e2235}
table{width:100%;border-collapse:collapse}
th{font-size:.65rem;letter-spacing:1px;text-transform:uppercase;color:#64748b;padding:10px 16px;text-align:left;background:#0f1219}
td{padding:11px 16px;font-size:.8rem;border-top:1px solid #1a1d2a}
tr:hover td{background:#13162040}
.pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:.67rem;font-weight:600}
.pill.booked{background:#14532d30;color:#4ade80;border:1px solid #166534}
.pill.noanswer{background:#7c280030;color:#fb923c;border:1px solid #9a3412}
.pill.notinterested{background:#4c0d0d30;color:#f87171;border:1px solid #7f1d1d}
.pill.completed{background:#1e3a5f30;color:#60a5fa;border:1px solid #1e40af}
.pill.callback{background:#3b2f0030;color:#fbbf24;border:1px solid #92400e}
.pill.initiated{background:#1e2a3a30;color:#94a3b8;border:1px solid #334155}
.pill.hot{background:#7c1d1d30;color:#f87171;border:1px solid #991b1b}
.pill.warm{background:#451a0330;color:#fb923c;border:1px solid #92400e}
.pill.cold{background:#1e3a5f30;color:#60a5fa;border:1px solid #1e3a5f}
.active-call{background:#0f2a1a;border:1px solid #14532d;border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px;margin-bottom:8px}
.active-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:pulse 1s infinite;flex-shrink:0}
.bottom-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
.update-bar{text-align:center;padding:10px;font-size:.7rem;color:#374151;margin-top:20px}
@media(max-width:900px){.charts-grid{grid-template-columns:1fr}.bottom-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>MYL <span>AI</span> Command Center</h1>
    <div style="font-size:.72rem;color:#475569;margin-top:4px">MakeYourLabel — 360° Lead Intelligence</div>
  </div>
  <div style="display:flex;align-items:center;gap:12px">
    <div class="badge"><span class="dot"></span> LIVE</div>
    <div id="lastUpdated" style="font-size:.72rem;color:#475569">Loading...</div>
  </div>
</div>

<div class="container">

  <div class="section-title">AI Performance KPIs</div>
  <div class="kpi-grid" id="kpiGrid"></div>

  <div class="section-title">Call Outcomes · Lead Ratings · Daily Volume</div>
  <div class="charts-grid">
    <div class="chart-card"><h3>Call Outcomes</h3><div class="chart-wrap"><canvas id="statusChart"></canvas></div></div>
    <div class="chart-card"><h3>Calls Per Day (Last 7 Days)</h3><div class="chart-wrap"><canvas id="dailyChart"></canvas></div></div>
    <div class="chart-card"><h3>Lead Ratings</h3><div class="chart-wrap"><canvas id="ratingChart"></canvas></div></div>
  </div>

  <div class="bottom-grid">
    <div>
      <div class="section-title">Lead Journey Funnel</div>
      <div class="chart-card" id="funnelCard"></div>
    </div>
    <div>
      <div class="section-title">Lead Source Breakdown</div>
      <div class="chart-card"><h3>Source Performance</h3><div class="chart-wrap"><canvas id="sourceChart"></canvas></div></div>
    </div>
  </div>

  <div class="section-title">Live Activity</div>
  <div id="activeCalls"></div>

  <div class="section-title">Recent AI Calls</div>
  <div class="table-card">
    <h3>Last 15 Processed Leads</h3>
    <div style="overflow-x:auto"><table>
      <thead><tr>
        <th>Lead</th><th>Company</th><th>Status</th><th>Rating</th>
        <th>Duration</th><th>Retries</th><th>Source</th><th>Date</th>
      </tr></thead>
      <tbody id="leadsTable"></tbody>
    </table></div>
  </div>

  <div class="update-bar" id="updateBar">Auto-refreshes every 90 seconds</div>
</div>

<script>
let statusChart, dailyChart, ratingChart, sourceChart;

const STATUS_COLORS = {
  'Consultation Booked': '#4ade80',
  'No Answer / Voicemail': '#fb923c',
  'Not Interested': '#f87171',
  'Call Completed': '#60a5fa',
  'Callback Requested': '#fbbf24',
  'Call Initiated': '#94a3b8',
};

function pillClass(s) {
  if (!s) return 'initiated';
  if (s.includes('Consultation')) return 'booked';
  if (s.includes('No Answer')) return 'noanswer';
  if (s.includes('Not Interested')) return 'notinterested';
  if (s.includes('Completed')) return 'completed';
  if (s.includes('Callback')) return 'callback';
  return 'initiated';
}

function ratingClass(r) { return r === 'Hot' ? 'hot' : r === 'Cold' ? 'cold' : 'warm'; }

function fmtDuration(s) {
  if (!s || s === 0) return '—';
  const m = Math.floor(s / 60), sec = s % 60;
  return m > 0 ? m + 'm ' + sec + 's' : sec + 's';
}

function render(d) {
  document.getElementById('lastUpdated').textContent = d.lastUpdated;

  // KPIs
  const kpis = [
    { label: 'Total Leads', value: d.kpis.totalLeads, sub: 'in CRM', cls: 'blue' },
    { label: 'AI Calls Made', value: d.kpis.totalCalled, sub: 'all time', cls: 'purple' },
    { label: 'Calls Today', value: d.kpis.callsToday, sub: 'IST today', cls: 'blue' },
    { label: 'Consultations', value: d.kpis.consultationsBooked, sub: 'booked', cls: 'green' },
    { label: 'Converted', value: d.kpis.converted, sub: 'clients', cls: 'green' },
    { label: 'Hot Leads', value: d.kpis.hotLeads, sub: 'high priority', cls: 'red' },
    { label: 'Success Rate', value: d.kpis.successRate + '%', sub: 'calls → consult', cls: 'yellow' },
    { label: 'Connect Rate', value: d.kpis.connectRate + '%', sub: 'calls → connected', cls: 'orange' },
    { label: 'Avg Duration', value: fmtDuration(d.kpis.avgDuration), sub: 'per call', cls: 'blue' },
    { label: 'Retry Queue', value: d.kpis.retryQueue, sub: 'pending retries', cls: 'orange' },
    { label: 'Total Retries', value: d.kpis.totalRetries, sub: 'all time', cls: 'red' },
    { label: 'Tunnel', value: 'LIVE', sub: d.tunnel.replace('https://','').slice(0,22)+'…', cls: 'green' },
  ];
  document.getElementById('kpiGrid').innerHTML = kpis.map(k =>
    \`<div class="kpi \${k.cls}"><div class="kpi-label">\${k.label}</div><div class="kpi-value">\${k.value}</div><div class="kpi-sub">\${k.sub}</div></div>\`
  ).join('');

  // Status donut
  const statusLabels = Object.keys(d.charts.statusCounts);
  const statusVals = statusLabels.map(k => d.charts.statusCounts[k]);
  if (statusChart) statusChart.destroy();
  statusChart = new Chart(document.getElementById('statusChart'), {
    type: 'doughnut',
    data: { labels: statusLabels, datasets: [{ data: statusVals, backgroundColor: statusLabels.map(l => STATUS_COLORS[l] || '#64748b'), borderWidth: 0, hoverOffset: 6 }] },
    options: { plugins: { legend: { position: 'bottom', labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12, padding: 10 } } }, maintainAspectRatio: false, cutout: '65%' }
  });

  // Daily bar
  if (dailyChart) dailyChart.destroy();
  dailyChart = new Chart(document.getElementById('dailyChart'), {
    type: 'bar',
    data: { labels: d.charts.daily.labels, datasets: [{ label: 'Calls', data: d.charts.daily.values, backgroundColor: '#4f46e580', borderColor: '#6366f1', borderWidth: 2, borderRadius: 6 }] },
    options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#64748b', font: { size: 11 } }, grid: { color: '#1e2235' } }, y: { ticks: { color: '#64748b', font: { size: 11 }, stepSize: 1 }, grid: { color: '#1e2235' }, beginAtZero: true } }, maintainAspectRatio: false }
  });

  // Rating donut
  const ratingLabels = ['Hot', 'Warm', 'Cold'];
  const ratingColors = ['#f87171', '#fb923c', '#60a5fa'];
  if (ratingChart) ratingChart.destroy();
  ratingChart = new Chart(document.getElementById('ratingChart'), {
    type: 'doughnut',
    data: { labels: ratingLabels, datasets: [{ data: ratingLabels.map(l => d.charts.intentCounts[l] || 0), backgroundColor: ratingColors, borderWidth: 0, hoverOffset: 6 }] },
    options: { plugins: { legend: { position: 'bottom', labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12, padding: 10 } } }, maintainAspectRatio: false, cutout: '65%' }
  });

  // Source bar
  const srcLabels = Object.keys(d.charts.sourceCounts).slice(0, 8);
  const srcVals = srcLabels.map(k => d.charts.sourceCounts[k]);
  if (sourceChart) sourceChart.destroy();
  sourceChart = new Chart(document.getElementById('sourceChart'), {
    type: 'bar',
    data: { labels: srcLabels, datasets: [{ data: srcVals, backgroundColor: '#7c3aed80', borderColor: '#8b5cf6', borderWidth: 2, borderRadius: 6 }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e2235' }, beginAtZero: true }, y: { ticks: { color: '#94a3b8', font: { size: 11 } }, grid: { display: false } } }, maintainAspectRatio: false }
  });

  // Funnel
  const funnelKeys = Object.keys(d.funnel);
  const funnelMax = d.funnel[funnelKeys[0]] || 1;
  document.getElementById('funnelCard').innerHTML = '<h3>Lead Journey</h3>' +
    funnelKeys.map((k, i) => {
      const v = d.funnel[k];
      const pct = Math.round((v / funnelMax) * 100);
      const prevV = i > 0 ? d.funnel[funnelKeys[i-1]] : v;
      const convPct = prevV > 0 ? Math.round((v / prevV) * 100) : 100;
      return \`<div class="funnel-row">
        <div class="funnel-label">\${k}</div>
        <div class="funnel-bar-wrap"><div class="funnel-bar" style="width:\${pct}%"><span>\${v}</span></div></div>
        <div class="funnel-pct">\${i === 0 ? '—' : convPct + '%'}</div>
      </div>\`;
    }).join('');

  // Active calls
  const ac = d.activeCalls;
  document.getElementById('activeCalls').innerHTML = ac.length === 0
    ? '<div style="color:#374151;font-size:.8rem;padding:8px 0">No active calls right now</div>'
    : ac.map(c => \`<div class="active-call"><div class="active-dot"></div><span style="font-size:.8rem;color:#94a3b8">Call ID: <b style="color:#e2e8f0">\${c.callId}</b></span><span style="font-size:.78rem;color:#64748b;margin-left:8px">Lead: \${c.leadId}</span><span style="font-size:.78rem;color:#64748b;margin-left:auto">\${c.ageMin}m ago</span></div>\`).join('');

  // Table
  document.getElementById('leadsTable').innerHTML = d.recentLeads.map(l => \`
    <tr>
      <td><b>\${l.name}</b></td>
      <td style="color:#64748b">\${l.company}</td>
      <td><span class="pill \${pillClass(l.status)}">\${l.status || '—'}</span></td>
      <td><span class="pill \${ratingClass(l.rating)}">\${l.rating}</span></td>
      <td style="color:#94a3b8">\${fmtDuration(l.duration)}</td>
      <td style="color:\${l.retries > 0 ? '#fb923c' : '#64748b'}">\${l.retries > 0 ? l.retries + 'x' : '—'}</td>
      <td style="color:#64748b;font-size:.75rem">\${l.source}</td>
      <td style="color:#64748b;font-size:.75rem">\${l.date}</td>
    </tr>
  \`).join('');
}

async function load() {
  try {
    const r = await fetch('/api/dashboard-data');
    const d = await r.json();
    render(d);
    document.getElementById('updateBar').textContent = 'Last loaded: ' + d.lastUpdated + ' · Auto-refreshes every 90s';
  } catch(e) {
    document.getElementById('updateBar').textContent = 'Error loading data — retrying...';
  }
}

load();
setInterval(load, 90000);
</script>
</body>
</html>`);
});

// ── REMOTE MCP SERVER (StreamableHTTP) — for claude.ai web connector ─────────
// Connect at: https://<railway-domain>/mcp
const { McpServer }                    = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { randomUUID }                   = require('crypto');
const { z } = require('zod');

const mcpTransports = {}; // sessionId → transport

function createMylMcpServer() {
  const mcp = new McpServer({ name: 'myl-workflow', version: '1.0.0' });

  mcp.tool('myl_dashboard', 'Get MYL KPIs, funnel stats, recent AI call activity', {}, async () => {
    try {
      const d = await getDashboardData();
      const k = d.kpis;
      const lines = [
        `=== MYL AI Dashboard — ${d.lastUpdated} ===`,
        `Total Leads: ${k.totalLeads} | AI Calls: ${k.totalCalled} | Today: ${k.callsToday}`,
        `Consultations: ${k.consultationsBooked} | Converted: ${k.converted} | Hot Leads: ${k.hotLeads}`,
        `Success Rate: ${k.successRate}% | Connect Rate: ${k.connectRate}% | Avg Duration: ${Math.floor(k.avgDuration/60)}m${k.avgDuration%60}s`,
        `Retry Queue: ${k.retryQueue}`,
        '', '── Call Outcomes ──',
        ...Object.entries(d.charts.statusCounts).map(([s,n]) => `  ${s}: ${n}`),
        '', '── Funnel ──',
        ...Object.entries(d.funnel).map(([s,n]) => `  ${s}: ${n}`),
        '', '── Recent Calls ──',
        ...d.recentLeads.map(l => `  ${l.name} | ${l.company} | ${l.status} | ${Math.floor(l.duration/60)}m${l.duration%60}s | ${l.date}`),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  });

  mcp.tool('myl_get_lead', 'Fetch a Zoho CRM lead by ID with all AI call fields',
    { lead_id: z.string().describe('Zoho lead ID') },
    async ({ lead_id }) => {
      try {
        const lead = await fetchLead(lead_id);
        if (!lead) return { content: [{ type: 'text', text: 'Lead not found.' }] };
        const lines = [
          `ID: ${lead.id}`,
          `Name: ${lead.First_Name || ''} ${lead.Last_Name || ''}`.trim(),
          lead.Phone   ? `Phone: ${lead.Phone}` : null,
          lead.Mobile  ? `Mobile: ${lead.Mobile}` : null,
          lead.Email   ? `Email: ${lead.Email}` : null,
          lead.Company ? `Company: ${lead.Company}` : null,
          lead.Lead_Source ? `Source: ${lead.Lead_Source}` : null,
          lead.Lead_Status ? `Status: ${lead.Lead_Status}` : null,
          lead.Buying_Intent ? `Buying Intent: ${lead.Buying_Intent}` : null,
          lead.AI_Last_Call_Status ? `Last AI Call: ${lead.AI_Last_Call_Status}` : null,
          lead.AI_Call_Duration !== undefined ? `Duration: ${lead.AI_Call_Duration}s` : null,
          lead.AI_Last_Call_Date ? `Call Date: ${lead.AI_Last_Call_Date}` : null,
          lead.AI_Call_Retry_Count !== undefined ? `Retries: ${lead.AI_Call_Retry_Count}` : null,
          lead.Description ? `\nNotes:\n${lead.Description.slice(0, 600)}` : null,
        ].filter(Boolean).join('\n');
        return { content: [{ type: 'text', text: lines }] };
      } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
    }
  );

  mcp.tool('myl_search_leads', 'Search Zoho CRM leads by name, email, or phone',
    {
      query:    z.string().describe('Search string'),
      criteria: z.enum(['email','phone','word']).optional().describe('Search type (default: word)'),
    },
    async ({ query, criteria = 'word' }) => {
      try {
        const token = await getZohoToken();
        const r = await axios.get(
          `${CONFIG.zoho.baseUrl}/crm/v2/Leads/search?${criteria}=${encodeURIComponent(query)}&fields=id,First_Name,Last_Name,Phone,Mobile,Email,Company,Lead_Status,AI_Last_Call_Status,AI_Last_Call_Date`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const leads = r.data?.data || [];
        if (!leads.length) return { content: [{ type: 'text', text: 'No leads found.' }] };
        const lines = leads.slice(0,10).map(l =>
          `[${l.id}] ${l.First_Name||''} ${l.Last_Name||''} | ${l.Phone||l.Mobile||'—'} | ${l.Email||'—'} | ${l.Lead_Status||'—'} | AI: ${l.AI_Last_Call_Status||'Not Called'}`
        );
        return { content: [{ type: 'text', text: `${leads.length} result(s):\n\n${lines.join('\n')}` }] };
      } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
    }
  );

  mcp.tool('myl_trigger_call', 'Trigger a Synthflow AI call for a lead',
    { lead_id: z.string().describe('Zoho lead ID') },
    async ({ lead_id }) => {
      try {
        const lead = await fetchLead(lead_id);
        if (!lead) return { content: [{ type: 'text', text: 'Lead not found.' }] };
        const { callId, agentType, agentZohoValue } = await triggerCall(lead);
        logCall({ leadId: lead.id, name: `${lead.First_Name} ${lead.Last_Name}`, phone: lead.Phone, callId, status: 'Manual Call', attempt: 1 });
        await updateLead(lead.id, { AI_Agent_Used: agentZohoValue, AI_Last_Call_Date: new Date().toISOString(), Lead_Status: 'Attempted to Contact' });
        return { content: [{ type: 'text', text: `Call triggered.\nCall ID: ${callId}\nAgent: ${agentType}` }] };
      } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
    }
  );

  mcp.tool('myl_update_lead', 'Update Zoho CRM lead fields',
    {
      lead_id: z.string().describe('Zoho lead ID'),
      fields:  z.record(z.unknown()).describe('Fields to update, e.g. { "Lead_Status": "Pre-Qualified", "Buying_Intent": "Hot" }'),
    },
    async ({ lead_id, fields }) => {
      try {
        await updateLead(lead_id, fields);
        return { content: [{ type: 'text', text: `Lead ${lead_id} updated: ${Object.keys(fields).join(', ')}` }] };
      } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
    }
  );

  mcp.tool('myl_create_note', 'Add a note to a Zoho CRM lead',
    {
      lead_id: z.string(),
      title:   z.string(),
      content: z.string(),
    },
    async ({ lead_id, title, content }) => {
      try {
        await createZohoNote(lead_id, title, content);
        return { content: [{ type: 'text', text: `Note "${title}" added to lead ${lead_id}.` }] };
      } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
    }
  );

  mcp.tool('myl_create_task', 'Create a follow-up task for a Zoho lead',
    {
      lead_id:     z.string(),
      lead_name:   z.string(),
      subject:     z.string(),
      description: z.string().optional(),
      due_days:    z.number().int().min(0).max(30).optional(),
    },
    async ({ lead_id, lead_name, subject, description = '', due_days = 1 }) => {
      try {
        await createZohoTask(lead_id, lead_name, subject, description, due_days);
        return { content: [{ type: 'text', text: `Task "${subject}" created for ${lead_name}.` }] };
      } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
    }
  );

  mcp.tool('myl_list_recent_leads', 'List most recently created Zoho leads',
    { count: z.number().int().min(1).max(25).optional().describe('How many to return (default 10)') },
    async ({ count = 10 }) => {
      try {
        const token = await getZohoToken();
        const r = await axios.get(
          `${CONFIG.zoho.baseUrl}/crm/v2/Leads?fields=id,First_Name,Last_Name,Phone,Email,Company,Lead_Status,Lead_Source,AI_Last_Call_Status,Created_Time&sort_by=Created_Time&sort_order=desc&per_page=${count}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const leads = r.data?.data || [];
        if (!leads.length) return { content: [{ type: 'text', text: 'No leads found.' }] };
        const lines = leads.map((l, i) => {
          const created = l.Created_Time ? new Date(l.Created_Time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' }) : '—';
          return `${i+1}. [${l.id}] ${l.First_Name||''} ${l.Last_Name||''} | ${l.Company||'—'} | ${l.Lead_Status||'—'} | ${created}`;
        });
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
    }
  );

  mcp.tool('myl_server_health', 'Check MYL Railway server health and retry queue', {}, async () => {
    return { content: [{ type: 'text', text: `Server: OK\nRetry Queue: ${retryQueue.size} leads\nActive Calls: ${callMonitor.size}\nURL: ${CONFIG.publicUrl}` }] };
  });

  return mcp;
}

// POST /mcp — initialize new session or handle existing session messages
app.post('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (sessionId && mcpTransports[sessionId]) {
      // Existing session — reuse transport
      transport = mcpTransports[sessionId];
    } else if (!sessionId || req.body?.method === 'initialize') {
      // New session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { mcpTransports[sid] = transport; },
      });
      transport.onclose = () => {
        if (transport.sessionId) delete mcpTransports[transport.sessionId];
      };
      const mcpServer = createMylMcpServer();
      await mcpServer.connect(transport);
    } else {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad session' }, id: null });
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[MCP POST] Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// GET /mcp — SSE stream for server-initiated messages
app.get('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    const transport = sessionId && mcpTransports[sessionId];
    if (!transport) return res.status(404).json({ error: 'Session not found' });
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('[MCP GET] Error:', err.message);
    if (!res.headersSent) res.status(500).end();
  }
});

// DELETE /mcp — client closes session
app.delete('/mcp', (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && mcpTransports[sessionId]) delete mcpTransports[sessionId];
  res.status(200).end();
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n MYL Workflow Server running on port ${PORT}`);
  console.log(` Public URL: ${CONFIG.publicUrl}\n`);
  await onStartup();
});
