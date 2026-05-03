'use strict';

require('dotenv').config();

const Anthropic              = require('@anthropic-ai/sdk');
const { createClient }       = require('@supabase/supabase-js');
const { Resend }             = require('resend');
const paypal                 = require('@paypal/checkout-server-sdk');

const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase   = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const resend     = new Resend(process.env.RESEND_API_KEY);

const paypalEnv  = process.env.PAYPAL_MODE === 'live'
  ? new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
  : new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
const paypalClient = new paypal.core.PayPalHttpClient(paypalEnv);

const TIERS = {
  basic: { price: '99.00',  label: 'MYL Basic Onboarding',          credit: 99  },
  pro:   { price: '499.00', label: 'MYL Pro — Dedicated Co-founder', credit: 499 },
};

const PAYPAL_BASE = process.env.PAYPAL_MODE === 'live'
  ? 'https://api.paypal.com'
  : 'https://api.sandbox.paypal.com';

const CRM_BASE  = 'https://www.zohoapis.in/crm/v2';
const SF_BASE   = 'https://api.synthflow.ai/v2';
const FROM      = process.env.EMAIL_FROM || 'alex@makeyourlabel.com';

module.exports = { anthropic, supabase, resend, paypalClient, TIERS, PAYPAL_BASE, CRM_BASE, SF_BASE, FROM };
