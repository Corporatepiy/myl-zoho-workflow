'use strict';

const rateLimit = require('express-rate-limit');

// One outbound call per phone number per hour.
// Uses IP as the key since we can't key on body params with express-rate-limit.
const intakeLimit = rateLimit({
  windowMs:         60 * 60 * 1000,
  max:              3,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many requests — try again later.' },
});

// Light protection for blueprint + consult — they burn Opus tokens.
const brainLimit = rateLimit({
  windowMs:         60 * 1000,
  max:              30,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Rate limit hit — slow down.' },
});

module.exports = { intakeLimit, brainLimit };
