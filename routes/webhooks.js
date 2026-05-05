'use strict';

const router = require('express').Router();
const { enrichCall }              = require('../brain');
const { refreshPatterns, shouldRefresh } = require('../brain/patterns');
const { updateLead, logCall }     = require('../crm/zoho');
const { handleSuccessfulPayment, verifyPayPalWebhook } = require('../payments/paypal');
const { parseCustomId }           = require('../payments/paypal');
const { insertCall, getPanelAccount, getBlueprint } = require('../store/supabase');
const { sendBrandReport }         = require('../email/resend');
const { buildContextBlock }       = require('../brain/patterns');

// ── Synthflow post-call webhook ───────────────────────────────
// Responds 200 immediately so Synthflow doesn't retry.
// All processing is async fire-and-forget.
router.post('/synthflow', (req, res) => {
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      console.log('RAW SYNTHFLOW PAYLOAD:', JSON.stringify(req.body, null, 2));

      const payload = req.body?.call || req.body;

      const call_id  = payload.call_id  || payload.id || payload.callId || '';
      const status   = payload.call_status || payload.event_type || payload.status || '';

      // Guard: only process terminal call events
      const TERMINAL = ['ended', 'completed', 'finished', 'call_ended'];
      if (!TERMINAL.includes(status)) {
        console.log(`[synthflow] ignoring non-terminal event: "${status}" — call_id: ${call_id}`);
        return;
      }

      // Dynamic variables — Synthflow nests them under different keys by version
      const vars = payload.dynamic_variables || payload.variables || payload.call_variables || {};

      // Transcript — string or [{role, content}] array depending on Synthflow version
      const transcriptRaw = payload.transcript || payload.messages;
      const transcript = Array.isArray(transcriptRaw)
        ? transcriptRaw.map(m => `${m.role}: ${m.content}`).join('\n')
        : (transcriptRaw || '');

      // Duration — prefer direct field, fall back to timestamp diff
      // Synthflow may send timestamps in seconds OR milliseconds
      const dur_direct  = payload.call_duration || payload.duration;
      const ts_start    = payload.start_timestamp || payload.start_time;
      const ts_end      = payload.end_timestamp   || payload.end_time;
      let   duration    = 0;
      if (dur_direct != null) {
        duration = Math.round(Number(dur_direct)) || 0;
      } else if (ts_start && ts_end) {
        const s = Number(ts_start);
        const e = Number(ts_end);
        // timestamps > 1e12 are milliseconds; otherwise seconds
        duration = s > 1e12 ? Math.round((e - s) / 1000) : Math.round(e - s);
      }

      const disconnection_reason = payload.disconnection_reason || payload.end_reason || payload.hangup_cause || '';

      console.log(`[synthflow] ${call_id} ended — status: ${status}, duration: ${duration}s, email: ${vars.email || 'none'}`);

      // If the agent didn't call send_brand_email during the call,
      // retrieve the stored blueprint and send it now.
      if (vars.email && duration > 60) {
        const bp = await getBlueprint(vars.email).catch(() => null);
        if (bp) {
          sendBrandReport({ to: vars.email, name: vars.name, blueprint: bp })
            .catch(e => console.warn('[synthflow webhook] brand email failed:', e.message));
        }
      }

      if (!transcript) {
        console.warn(`[synthflow] ${call_id} — no transcript, skipping enrichment`);
        return;
      }

      // BUG 2 fix: enrichCall fallback so chain never hangs on Sonnet failure
      let enrichment;
      try {
        enrichment = await enrichCall({ transcript, leadData: vars });
      } catch (err) {
        console.error('[synthflow webhook] enrichCall failed:', err.message);
        enrichment = {
          lead_score: null, summary: null, founder_stage: null,
          garment_category: null, lead_quality: 'Cold',
          design_readiness: null, validation_appetite: null,
          journey_stage_revenue: null, pain_points: [], buying_signals: [],
          objections: [], next_step: null, cofounder_note: null,
        };
      }

      // BUG 3 fix: log Supabase errors loudly but don't abort Zoho/logCall
      try {
        await insertCall({
          call_id,
          duration_seconds: duration,
          outcome:          disconnection_reason,
          transcript,
          enrichment,
        });
      } catch (e) {
        console.error('[synthflow webhook] Supabase insertCall failed:', e.message);
      }

      // Log call to Zoho CRM Calls module (MYL Intelligence view) — always, even without email
      logCall({
        email:           vars.email || null,
        callId:          call_id,
        durationSeconds: duration,
        summary:         enrichment.summary,
        leadScore:       enrichment.lead_score,
        leadQuality:     enrichment.lead_quality,
        outcome:         disconnection_reason,
      }).catch(e => console.warn('[synthflow webhook] logCall failed:', e.message));

      if (vars.email) {
        updateLead({
          email:               vars.email,
          leadScore:           enrichment.lead_score,
          leadQuality:         enrichment.lead_quality,
          callSummary:         enrichment.summary,
          founderStage:        enrichment.founder_stage,
          designReadiness:     enrichment.design_readiness,
          validationAppetite:  enrichment.validation_appetite,
          journeyStageRevenue: enrichment.journey_stage_revenue,
        }).catch(e => console.warn('[synthflow webhook] zoho update failed:', e.message));
      }

      // Refresh pattern intelligence for this segment (fire-and-forget).
      // Runs only when patterns are stale (>6 hrs) and segment has ≥5 calls.
      const seg = {
        category: enrichment.garment_category || 'all',
        stage:    enrichment.founder_stage    || 'all',
      };
      shouldRefresh(seg)
        .then(stale => stale && refreshPatterns(seg))
        .catch(e => console.warn('[patterns] refresh error:', e.message));

    } catch (e) {
      console.error('[synthflow webhook]', e.message);
    }
  });
});

// ── Zoho CRM → trigger call ───────────────────────────────────
// Called by a Zoho workflow rule when a new lead is created.
// Auth: ?secret=<API_SECRET> query param (add to webhook URL in Zoho).
// Zoho sends: { leads: [{ First_Name, Last_Name, Email, Phone, Company, Description, ... }] }
// Does NOT re-create the Zoho lead — just triggers the Synthflow call.
router.post('/zoho-lead', async (req, res) => {
  // Verify secret
  if (req.query.secret !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.sendStatus(200); // respond immediately so Zoho doesn't retry

  setImmediate(async () => {
    try {
      // Zoho wraps records in a module-name array e.g. { leads: [...] } or { Leads: [...] }
      const records = req.body?.leads || req.body?.Leads || req.body?.data || [];
      const lead = Array.isArray(records) ? records[0] : records;

      if (!lead) {
        console.warn('[zoho-lead] no lead data in payload', JSON.stringify(req.body).slice(0, 200));
        return;
      }

      // Map Zoho field names → our intake fields
      // Covers standard Zoho fields + Meta Ads custom lead form fields
      const firstName = lead.First_Name        || lead.first_name        || '';
      const lastName  = lead.Last_Name         || lead.last_name         || '';
      const name      = lead.Full_Name         || lead.full_name         || lead.Name || lead.name
                     || `${firstName} ${lastName}`.trim();
      const email     = lead.Email             || lead.email             || '';
      const phone     = lead.Phone             || lead.phone             || lead.Mobile || lead.mobile
                     || lead.Phone_Number      || lead.phone_number      || '';
      const business  = lead.Company           || lead.company           || lead.Brand_Name
                     || lead.brand_name        || lead.Business_Name     || lead.business_name
                     || lead.Lead_Company      || '';
      // Meta Ads sends answers to custom questions in Description or dedicated fields
      const goal      = lead.Goal              || lead.goal
                     || lead.What_Are_You_Looking_To_Achieve
                     || lead.What_do_you_want_to_build
                     || lead.Description       || lead.description       || '';
      const category  = lead.Garment_Category  || lead.garment_category
                     || lead.What_type_of_clothing
                     || lead.Product_Category  || lead.product_category
                     || lead.Category          || lead.category          || '';
      const budget    = lead.Budget            || lead.budget
                     || lead.What_is_your_budget
                     || lead.Budget_Range      || lead.budget_range      || '';
      const market    = lead.Market            || lead.market
                     || lead.Target_Market     || lead.target_market
                     || lead.Country           || lead.country           || '';
      // Preserve Meta Ads source tag so Alex knows where this lead came from
      const source    = lead.Lead_Source       || lead.lead_source
                     || lead.Ad_Name           || lead.ad_name           || 'zoho-workflow';

      if (!phone) {
        console.warn(`[zoho-lead] no phone for ${email} — skipping call`);
        return;
      }

      const { getAgentForPhone, triggerCall } = require('../voice/synthflow');
      const agentId = getAgentForPhone(phone);

      if (!agentId) {
        console.warn(`[zoho-lead] no agent configured for phone ${phone}`);
        return;
      }

      console.log(`[zoho-lead] triggering call → ${phone} (${name})`);

      // Pre-call briefing: inject segment intelligence so Alex starts warm
      const segment_intel = await buildContextBlock({ category }).catch(() => '');

      await triggerCall({
        to:      phone,
        agentId,
        variables: {
          name,
          email:    email    || '',
          business: business || '',
          goal:     goal     || 'launch my fashion label',
          category: category || '',
          budget:   budget   || '',
          market:   market   || '',
          source,
          segment_intel: segment_intel || '',
          today:    new Date().toLocaleDateString('en-US', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
          }),
        },
      });

      console.log(`[zoho-lead] call triggered for ${name} (${phone})`);
    } catch (e) {
      console.error('[zoho-lead webhook]', e.message);
    }
  });
});

// ── PayPal webhook (safety net — also fires on successful capture) ──
// Verifies signature before processing. PAYPAL_WEBHOOK_ID must be set.
router.post('/paypal', async (req, res) => {
  try {
    const verified = await verifyPayPalWebhook(req);
    if (!verified) {
      console.warn('[paypal webhook] signature verification failed');
      return res.sendStatus(400);
    }
  } catch (e) {
    console.error('[paypal webhook] verification error:', e.message);
    return res.sendStatus(400);
  }

  res.sendStatus(200);

  setImmediate(async () => {
    try {
      if (req.body.event_type !== 'PAYMENT.CAPTURE.COMPLETED') return;

      const { tier, email, name } = parseCustomId(req.body.resource?.custom_id);
      if (!email) return;

      // handleSuccessfulPayment is idempotent — safe to call even if already fulfilled
      await handleSuccessfulPayment({
        email,
        name,
        tier,
        orderId: req.body.resource?.id,
      });
    } catch (e) {
      console.error('[paypal webhook]', e.message);
    }
  });
});

module.exports = router;
