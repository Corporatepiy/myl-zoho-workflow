'use strict';

const router = require('express').Router();
const { getPanelAccount, createPanelAccount } = require('../store/supabase');
const { requireAuth }     = require('../middleware/auth');

// Protected — requires x-api-secret header.
// Credit a paid founder's wallet (Stripe path, 5 Oct 2026): the connector's Stripe webhook calls this after the Zoho deal.
// Upsert by email: a second call for the same email reloads the same credit, never doubles it.
router.post('/credit', requireAuth, async (req, res) => {
  try {
    const { email, name, tier, credit, source } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const t = (tier === 'pro') ? 'pro' : 'basic';
    const account = await createPanelAccount({ email, name: name || '', tier: t, credit: Number(credit) || (t === 'pro' ? 499 : 99) });
    console.log(`[panel] credited ${t} ${account.credit_balance} for ${email} via ${source || 'api'}`);
    res.json({ ok: true, email: account.email, tier: account.tier, credit_balance: account.credit_balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/account', requireAuth, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const account = await getPanelAccount(email);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    res.json(account);
  } catch (e) {
    console.error('[panel account]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
