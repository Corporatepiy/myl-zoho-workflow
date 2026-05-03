'use strict';

const router = require('express').Router();
const { blueprint, consultBrain } = require('../brain');
const { createDeal }              = require('../crm/zoho');
const { updateLead }              = require('../crm/zoho');
const { sendBrandReport, sendConsultationConfirmation } = require('../email/resend');
const { storeBlueprint }          = require('../store/supabase');
const { brainLimit }              = require('../middleware/rate');

// Synthflow tool calls can wrap params in different keys depending on the platform version.
const unwrap = (b) => b.args || b.arguments || b.parameters || b;

// ── get_brand_blueprint ───────────────────────────────────────
// Called by Alex once she has: category + stage + blocker.
// Stores the blueprint in Supabase so the webhook can retrieve it later.
router.post('/blueprint', brainLimit, async (req, res) => {
  try {
    const { name, business, goal, category, budget, stage, market, moment } = req.body;
    if (!name || !business) return res.status(400).json({ error: 'name and business required' });

    const result = await blueprint({
      name, business, goal,
      data: { category, budget, stage, market, moment },
    });

    // Store so the post-call webhook can email it without regenerating
    if (req.body.email) {
      storeBlueprint({ email: req.body.email, blueprint: result }).catch(() => {});
    }

    res.json({ blueprint: result });
  } catch (e) {
    console.error('[blueprint]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── consult_brain ─────────────────────────────────────────────
// Called mid-call with the founder's exact spoken words.
// Returns 1-2 sentences Alex speaks immediately.
router.post('/consult-brain', brainLimit, async (req, res) => {
  try {
    const { question, name, primary_goal, brand_context } = unwrap(req.body);
    if (!question) return res.status(400).json({ error: 'question required' });
    res.json(await consultBrain({ question, name, primary_goal, brand_context }));
  } catch (e) {
    console.error('[consult-brain]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── send_brand_email ──────────────────────────────────────────
router.post('/send-brand-email', async (req, res) => {
  try {
    const { email, name, blueprint: bp } = unwrap(req.body);
    if (!email) return res.status(400).json({ error: 'email required' });
    await sendBrandReport({ to: email, name, blueprint: bp });
    res.json({ sent: true });
  } catch (e) {
    console.error('[send-brand-email]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── book_consultation ─────────────────────────────────────────
router.post('/book-consultation', async (req, res) => {
  try {
    const { name, email, phone, business, goal } = unwrap(req.body);
    await Promise.all([
      createDeal({ name, email, phone, business, goal }),
      email && sendConsultationConfirmation({ to: email, name, business }),
    ]);
    res.json({ booked: true });
  } catch (e) {
    console.error('[book-consultation]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── tag_prospect (silent) ─────────────────────────────────────
router.post('/tag-prospect', async (req, res) => {
  const { email, quality } = unwrap(req.body);
  updateLead({ email, leadQuality: quality || 'Warm' }).catch(() => {});
  res.json({ tagged: true });
});

module.exports = router;
