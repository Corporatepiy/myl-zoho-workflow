'use strict';

const router = require('express').Router();
const { getPanelAccount } = require('../store/supabase');
const { requireAuth }     = require('../middleware/auth');

// Protected — requires x-api-secret header.
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
