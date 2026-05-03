'use strict';

const { resend, FROM } = require('../config');

async function sendBrandReport({ to, name, blueprint: bp }) {
  const b = bp || {};
  await resend.emails.send({
    from:    FROM,
    to,
    subject: `Your MYL brand blueprint${name ? `, ${name}` : ''}`,
    html: `<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
<h1 style="font-size:22px;font-weight:500;margin:0 0 4px">Your brand blueprint</h1>
<p style="color:#888;font-size:14px;margin:0 0 32px">Make Your Label — design, validate, scale what works</p>

${b.reading ? `<div style="background:#f7f5ff;border-left:3px solid #7F77DD;padding:16px 20px;margin-bottom:28px"><p style="margin:0;font-size:15px;line-height:1.7">${b.reading}</p></div>` : ''}

<table style="width:100%;border-collapse:collapse;margin-bottom:24px">
  <tr><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:13px;color:#888;width:42%">Brand archetype</td><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;font-weight:500">${b.brand_archetype || '—'}</td></tr>
  <tr><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:13px;color:#888">First design moment</td><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px">${b.first_design?.moment_1 || '—'}</td></tr>
  <tr><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:13px;color:#888">Validation units</td><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px">${b.validation_plan?.units || '10–50 units'}</td></tr>
  <tr><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:13px;color:#888">Go signal</td><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px">${b.validation_plan?.go_signal || '—'}</td></tr>
  <tr><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:13px;color:#888">Kill signal</td><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#c0392b">${b.validation_plan?.kill_signal || '—'}</td></tr>
  <tr><td style="padding:10px 0;font-size:13px;color:#888">Scale gate</td><td style="padding:10px 0;font-size:14px;font-weight:500">${b.scale_gate || '—'}</td></tr>
</table>

${b['90_day_move'] ? `<p style="font-size:14px;margin:0 0 24px"><strong>Your 90-day move:</strong> ${b['90_day_move']}</p>` : ''}

<div style="border-top:1px solid #eee;padding-top:24px">
  <a href="${process.env.PANEL_URL || 'https://makeyourlabel.com/panel'}" style="display:inline-block;background:#7F77DD;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px">Start your journey →</a>
</div>
<p style="font-size:12px;color:#aaa;margin:24px 0 0">Make Your Label · Reply to talk to Alex</p>
</body>`,
  });
}

async function sendWelcomeEmail({ to, name, tier, credit }) {
  const isPro = tier === 'pro';
  await resend.emails.send({
    from:    FROM,
    to,
    subject: `Welcome to MYL${name ? `, ${name}` : ''} — $${credit} credit loaded`,
    html: `<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
<h1 style="font-size:20px;font-weight:500;margin:0 0 8px">You're in. $${credit} loaded to your panel.</h1>
<p style="font-size:15px;line-height:1.7;color:#444">Hey ${name || 'there'} — your MYL ${isPro ? 'Pro' : 'Basic'} onboarding is confirmed. Every dollar you paid is sitting in your panel as credit. It applies to your first sampling order when you're ready to validate your first design.</p>
${isPro ? `<div style="background:#f0f7ff;border-left:3px solid #378ADD;padding:14px 18px;margin:20px 0;border-radius:0 8px 8px 0"><p style="margin:0;font-size:14px;color:#185FA5">Your dedicated co-founder will reach out within 24 hours to book your strategy call.</p></div>` : ''}
<p style="font-size:15px;line-height:1.7;color:#444">Log into your panel to start. Your first job is a design brief — not a production order.</p>
<div style="margin-top:24px"><a href="${process.env.PANEL_URL || 'https://makeyourlabel.com/panel'}" style="display:inline-block;background:#7F77DD;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px">Open your MYL panel →</a></div>
<p style="font-size:12px;color:#aaa;margin:24px 0 0">Make Your Label · design, validate, scale what works</p>
</body>`,
  });
}

async function sendConsultationConfirmation({ to, name, business }) {
  await resend.emails.send({
    from:    FROM,
    to,
    subject: `Co-founder call confirmed${name ? `, ${name}` : ''}`,
    html: `<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
<h1 style="font-size:20px;font-weight:500;margin:0 0 16px">You're booked.</h1>
<p style="font-size:15px;line-height:1.7;color:#444">Hey ${name || 'there'} — we'll be in touch to confirm your call time. We'll map out your first design brief and validation plan for ${business || 'your brand'}.</p>
<p style="font-size:14px;color:#888;margin-top:32px">— Alex, Make Your Label</p>
</body>`,
  });
}

module.exports = { sendBrandReport, sendWelcomeEmail, sendConsultationConfirmation };
