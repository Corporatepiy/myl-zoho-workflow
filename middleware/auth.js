'use strict';

// Protects internal endpoints (call insights, panel account lookup).
// Pass x-api-secret: <API_SECRET> header on every request.
function requireAuth(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) return next(); // skip in dev if not configured
  if (req.headers['x-api-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { requireAuth };
