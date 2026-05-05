'use strict';

const axios                = require('axios');
const paypal               = require('@paypal/checkout-server-sdk');
const { paypalClient, TIERS, PAYPAL_BASE } = require('../config');
const { getPanelAccount, createPanelAccount } = require('../store/supabase');
const { updateLead, createDeal } = require('../crm/zoho');
const { sendWelcomeEmail }       = require('../email/resend');

// ─────────────────────────────────────────────
// PAYPAL OAUTH — used only for webhook verification
// ─────────────────────────────────────────────

let _ppToken  = null;
let _ppExpiry = 0;

async function getPayPalOAuthToken() {
  if (_ppToken && Date.now() < _ppExpiry) return _ppToken;
  const { data } = await axios.post(
    `${PAYPAL_BASE}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth:    { username: process.env.PAYPAL_CLIENT_ID, password: process.env.PAYPAL_CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
  );
  _ppToken  = data.access_token;
  _ppExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _ppToken;
}

// ─────────────────────────────────────────────
// WEBHOOK SIGNATURE VERIFICATION
// Rejects any webhook POST that doesn't pass PayPal's own verification API.
// PAYPAL_WEBHOOK_ID must be set in .env — get it from your PayPal developer dashboard.
// ─────────────────────────────────────────────

async function verifyPayPalWebhook(req) {
  const token = await getPayPalOAuthToken();
  const { data } = await axios.post(
    `${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`,
    {
      auth_algo:         req.headers['paypal-auth-algo'],
      cert_url:          req.headers['paypal-cert-url'],
      transmission_id:   req.headers['paypal-transmission-id'],
      transmission_sig:  req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'],
      webhook_id:        process.env.PAYPAL_WEBHOOK_ID,
      webhook_event:     JSON.parse(req.rawBody),
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
  );
  return data.verification_status === 'SUCCESS';
}

// ─────────────────────────────────────────────
// ORDER LIFECYCLE
// ─────────────────────────────────────────────

async function createOrder({ tier, founderEmail, founderName }) {
  const t = TIERS[tier] || TIERS.basic;
  const req = new paypal.orders.OrdersCreateRequest();
  req.prefer('return=representation');
  req.requestBody({
    intent: 'CAPTURE',
    purchase_units: [{
      amount:      { currency_code: 'USD', value: t.price },
      description: t.label,
      custom_id:   JSON.stringify({ tier, email: founderEmail, name: founderName }),
    }],
    application_context: {
      brand_name:   'MakeYourLabel',
      landing_page: 'BILLING',
      user_action:  'PAY_NOW',
      return_url:   `${process.env.BASE_URL}/api/paypal/success`,
      cancel_url:   `${process.env.BASE_URL}/api/paypal/cancel`,
    },
  });
  const res = await paypalClient.execute(req);
  return {
    orderId:    res.result.id,
    approveUrl: res.result.links.find(l => l.rel === 'approve')?.href,
  };
}

async function captureOrder(orderId) {
  const req = new paypal.orders.OrdersCaptureRequest(orderId);
  req.requestBody({});
  const res = await paypalClient.execute(req);
  return res.result;
}

function parseCustomId(raw) {
  try { return JSON.parse(raw || '{}'); }
  catch { return {}; }
}

// ─────────────────────────────────────────────
// FULFILMENT — idempotent, safe to call multiple times
// ─────────────────────────────────────────────

async function handleSuccessfulPayment({ email, name, tier, orderId }) {
  if (!email) return;

  // Idempotency: if the panel account already exists this payment was already processed.
  const existing = await getPanelAccount(email);
  if (existing) {
    console.log(`[payment] already fulfilled for ${email} — skipping`);
    return;
  }

  const t = TIERS[tier] || TIERS.basic;
  console.log(`[payment] fulfilling ${tier} — ${email} — ${orderId}`);

  await createPanelAccount({ email, name, tier, credit: t.credit });

  await Promise.allSettled([
    updateLead({
      email,
      leadQuality:         'Hot',
      callSummary:         `Paid ${tier} ($${t.price}). Panel created. Credit: $${t.credit}.`,
      leadScore:           tier === 'pro' ? 95 : 80,
      founderStage:        'ONBOARDED',
    }),
    sendWelcomeEmail({ to: email, name, tier, credit: t.credit }),
    tier === 'pro' && assignAccountManager({ email, name }),
  ]);
}

async function assignAccountManager({ email, name }) {
  await createDeal({ name, email, business: 'Pro Onboarding', goal: 'Assign dedicated AM' });
  if (process.env.SLACK_WEBHOOK_URL) {
    await axios.post(process.env.SLACK_WEBHOOK_URL, {
      text: `*New Pro founder* — ${name} (${email})\nAssign AM. $499 credit loaded.`,
    }).catch(() => {});
  }
}

module.exports = { createOrder, captureOrder, parseCustomId, verifyPayPalWebhook, handleSuccessfulPayment };
