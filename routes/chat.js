'use strict';

const router = require('express').Router();
const { companion } = require('../brain');

// Post-call co-founder support chat on website.
router.post('/', async (req, res) => {
  try {
    const { message, history, blueprint: bp } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    res.json(await companion({ message, history, blueprint: bp }));
  } catch (e) {
    console.error('[chat]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
