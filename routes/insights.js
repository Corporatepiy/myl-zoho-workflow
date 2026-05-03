'use strict';

const router = require('express').Router();
const { getRecentCalls } = require('../store/supabase');
const { requireAuth }    = require('../middleware/auth');

// Protected — requires x-api-secret header.
router.get('/', requireAuth, async (req, res) => {
  try {
    const calls = await getRecentCalls(50);
    res.json({
      calls,
      summary: {
        total:             calls.length,
        hot:               calls.filter(c => c.lead_quality === 'Hot').length,
        warm:              calls.filter(c => c.lead_quality === 'Warm').length,
        cold:              calls.filter(c => c.lead_quality === 'Cold').length,
        avg_score:         Math.round(calls.reduce((s, c) => s + (c.lead_score || 0), 0) / (calls.length || 1)),
        avg_duration:      Math.round(calls.reduce((s, c) => s + (c.duration_seconds || 0), 0) / (calls.length || 1)),
        design_ready:      calls.filter(c => ['HAS_DESIGN', 'HAS_SAMPLE'].includes(c.founder_stage)).length,
        high_validation:   calls.filter(c => c.validation_appetite === 'HIGH').length,
        recommended_pro:   calls.filter(c => c.recommended_onboarding === 'pro').length,
      },
    });
  } catch (e) {
    console.error('[call-insights]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
