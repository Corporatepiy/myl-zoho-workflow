'use strict';

const router = require('express').Router();
const { createOrder, captureOrder, parseCustomId, handleSuccessfulPayment } = require('../payments/paypal');

// ── Create PayPal order ───────────────────────────────────────
router.post('/create-order', async (req, res) => {
  try {
    const { tier, email, name } = req.body;
    if (!tier || !email) return res.status(400).json({ error: 'tier and email required' });
    res.json(await createOrder({ tier, founderEmail: email, founderName: name }));
  } catch (e) {
    console.error('[paypal create-order]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Capture order (JS SDK flow — frontend calls this after buyer approves) ──
router.post('/capture-order', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId required' });

    const capture = await captureOrder(orderId);
    const unit    = capture.purchase_units?.[0];
    const { tier, email, name } = parseCustomId(unit?.custom_id);
    const status  = unit?.payments?.captures?.[0]?.status;

    if (status === 'COMPLETED') {
      await handleSuccessfulPayment({ email, name, tier, orderId });
    }

    res.json({ captured: true, status, tier, email });
  } catch (e) {
    console.error('[paypal capture-order]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PayPal redirect after buyer approval (redirect flow) ──────
// Captures here ONLY when using the hosted redirect flow (return_url).
// If you're using the JS SDK buttons, buyers never hit this route.
router.get('/success', async (req, res) => {
  try {
    const capture = await captureOrder(req.query.token);
    const unit    = capture.purchase_units?.[0];
    const { tier, email, name } = parseCustomId(unit?.custom_id);

    if (unit?.payments?.captures?.[0]?.status === 'COMPLETED') {
      await handleSuccessfulPayment({ email, name, tier, orderId: req.query.token });
    }

    res.redirect(`${process.env.PANEL_URL}?welcome=true&tier=${tier || 'basic'}`);
  } catch (e) {
    console.error('[paypal success]', e.message);
    res.redirect(`${process.env.PANEL_URL}?error=capture_failed`);
  }
});

router.get('/cancel', (_, res) =>
  res.redirect(`${process.env.PANEL_URL}?cancelled=true`),
);

module.exports = router;
