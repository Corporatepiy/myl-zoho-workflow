'use strict';

const router = require('express').Router();
const { getRecentCalls, getLatestPattern } = require('../store/supabase');
const { refreshPatterns }                  = require('../brain/patterns');
const { requireAuth }                      = require('../middleware/auth');

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

// GET /api/insights/patterns?category=dresses&stage=IDEA
// Returns the latest extracted pattern for a segment.
router.get('/patterns', requireAuth, async (req, res) => {
  try {
    const { category = 'all', stage = 'all' } = req.query;
    const pattern = await getLatestPattern({ category, stage });
    res.json(pattern || { message: 'No pattern yet for this segment' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/insights/patterns/refresh
// Body: { category, stage }  (both optional — defaults to 'all')
// Manually triggers pattern extraction for a segment.
router.post('/patterns/refresh', requireAuth, async (req, res) => {
  try {
    const { category = 'all', stage = 'all' } = req.body;
    const patterns = await refreshPatterns({ category, stage });
    if (!patterns) return res.json({ message: 'Not enough calls yet (need ≥5)' });
    res.json({ refreshed: true, category, stage, patterns });
  } catch (e) {
    console.error('[insights] pattern refresh failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
