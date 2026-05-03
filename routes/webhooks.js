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

      if (call_status !== 'ended') return;

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
