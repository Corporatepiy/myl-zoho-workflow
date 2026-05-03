'use strict';

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');

const app = express();

// ── Raw body needed for PayPal webhook signature verification ──
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
}));
app.use(cors());

// ── Routes ────────────────────────────────────────────────────
app.use('/api/agent',         require('./routes/agent'));
app.use('/api/intake',        require('./routes/intake'));
app.use('/api/chat',          require('./routes/chat'));
app.use('/api/paypal',        require('./routes/payment'));
app.use('/api/panel',         require('./routes/panel'));
app.use('/api/call-insights', require('./routes/insights'));
app.use('/webhook',           require('./routes/webhooks'));

// ── Health ────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status:  'ok',
  version: 'MYL Brain v2 — journey-first',
  model:   'design → validate → scale winners',
  time:    new Date().toISOString(),
}));

// ── 404 ───────────────────────────────────────────────────────
app.use((_, res) => res.status(404).json({ error: 'Not found' }));

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
┌──────────────────────────────────────────────────┐
│  MYL Brain v2 · running on :${PORT}                  │
│  Journey-first · design → validate → scale       │
│  $99 Basic · $499 Pro · credits back to panel    │
└──────────────────────────────────────────────────┘
  `);
});
