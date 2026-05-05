'use strict';

const router = require('express').Router();
const { createLead }              = require('../crm/zoho');
const { getAgentForPhone, triggerCall } = require('../voice/synthflow');
const { buildContextBlock }       = require('../brain/patterns');
const { intakeLimit }             = require('../middleware/rate');

// Landing page form → create Zoho lead → trigger Synthflow call.
router.post('/', intakeLimit, async (req, res) => {
  try {
    const { name, email, phone, business, goal, category, budget, market, moment, source } = req.body;
    if (!name || !email || !phone) {
      return res.status(400).json({ error: 'name, email, phone required' });
    }

    const agentId = getAgentForPhone(phone);
    if (!agentId) return res.status(400).json({ error: 'No agent configured for this region' });

    // CRM lead creation is fire-and-forget — Zoho token expiry must not block calls
    createLead({ name, email, phone, business, goal, category, budget, source })
      .catch(e => console.warn('[intake] Zoho createLead failed (non-fatal):', e.message));

    // Pre-call briefing: inject what we know about this segment so Alex starts warm
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
        moment:   moment   || '',
        source:   'intake-form',
        segment_intel: segment_intel || '',
        today:    new Date().toLocaleDateString('en-US', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        }),
      },
    });

    res.json({ triggered: true });
  } catch (e) {
    console.error('[intake]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
