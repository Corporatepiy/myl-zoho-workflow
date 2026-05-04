'use strict';

const router = require('express').Router();
const { enrichCall }              = require('../brain');
const { refreshPatterns, shouldRefresh } = require('../brain/patterns');
const { updateLead }              = require('../crm/zoho');
const { handleSuccessfulPayment, verifyPayPalWebhook } = require('../payments/paypal');
const { parseCustomId }           = require('../payments/paypal');
const { insertCall, getPanelAccount, getBlueprint } = require('../store/supabase');
const { sendBrandReport }         = require('../email/resend');

// ── Synthflow post-call webhook ───────────────────────────────
// Responds 200 immediately so Synthflow doesn't retry.
// All processing is async fire-and-forget.
router.post('/synthflow', (req, res) => {
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      const payload = req.body?.call || req.body;
      const {
        call_id,
        call_status,
        transcript,
        dynamic_variables:  vars = {},
        start_timestamp,
        end_timestamp,
        disconnection_reason,
      } = payload;

      // Synthflow sends 'completed' or 'ended' depending on version
      const TERMINAL = ['ended', 'completed', 'finished'];
      if (!TERMINAL.includes(call_status)) return;

      const duration = (start_timestamp && end_timestamp)
        ? Math.round((end_timestamp - start_timestamp) / 1000)
        : 0;

      console.log(`[synthflow] ${call_id} ended — ${duration}s`);

      // If the agent didn't call send_brand_email during the call,
      // retrieve the stored blueprint and send it now.
      if (vars.email && duration > 60) {
        const bp = await getBlueprint(vars.email).catch(() => null);
        if (bp) {
          sendBrandReport({ to: vars.email, name: vars.name, blueprint: bp })
            .catch(e => console.warn('[synthflow webhook] brand email failed:', e.message));
        }
      }

      if (!transcript) return;

      const enrichment = await enrichCall({ transcript, leadData: vars });

      await insertCall({
        call_id,
        duration_seconds: duration,
        outcome:          disconnection_reason,
        transcript,
        enrichment,
      });

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
