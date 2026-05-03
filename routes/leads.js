'use strict';

const router = require('express').Router();
const { getLead, updateLead, addNote, addTask } = require('../crm/zoho');
const { requireAuth } = require('../middleware/auth');

// All routes require API secret
router.use(requireAuth);

// GET /api/leads?email=
router.get('/', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email required' });
    const lead = await getLead(email);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (e) {
    console.error('[leads GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/leads  { email, leadScore, leadQuality, callSummary, ... }
router.patch('/', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    await updateLead(req.body);
    res.json({ updated: true });
  } catch (e) {
    console.error('[leads PATCH]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/leads/note  { email, note }
router.post('/note', async (req, res) => {
  try {
    const { email, note } = req.body;
    if (!email || !note) return res.status(400).json({ error: 'email and note required' });
    await addNote({ email, note });
    res.json({ created: true });
  } catch (e) {
    console.error('[leads note]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/leads/task  { email, task, due_date }
router.post('/task', async (req, res) => {
  try {
    const { email, task } = req.body;
    if (!email || !task) return res.status(400).json({ error: 'email and task required' });
    await addTask(req.body);
    res.json({ created: true });
  } catch (e) {
    console.error('[leads task]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
