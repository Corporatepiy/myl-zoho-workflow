'use strict';

const { resend, FROM } = require('../config');

async function _send(payload) {
  const { data, error } = await resend.emails.send(payload);
  if (error) throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
  return data;
}

async function sendBrandReport({ to, name, blueprint: bp }) {
  const b    = bp || {};
  const fn   = name || 'there';
  const arch = b.brand_archetype    || null;
  const mom  = b.first_design?.moment_1 || null;
  const units= b.validation_plan?.units || '10–30 units';
  const go   = b.validation_plan?.go_signal  || null;
  const kill = b.validation_plan?.kill_signal || null;
  const gate = b.scale_gate        || null;
  const move = b['90_day_move']    || null;
  const read = b.reading           || null;
  const panel= process.env.PANEL_URL || 'https://makeyourlabel.com/panel';

  // Plain conversational HTML — no tables, no buttons, no branded headers.
  // Reads like a personal email from Alex, not a newsletter.
  const html = `<div style="font-family:Georgia,serif;max-width:560px;font-size:15px;line-height:1.8;color:#1a1a1a">

<p>Hey ${fn},</p>

<p>Just off our call — here is the blueprint I put together for you.</p>

${read ? `<p style="border-left:2px solid #ccc;padding-left:14px;color:#444;font-style:italic">${read}</p>` : ''}

${arch  ? `<p><strong>Your brand archetype:</strong> ${arch}</p>` : ''}
${mom   ? `<p><strong>First design moment:</strong> ${mom}</p>` : ''}

<p><strong>Validation plan:</strong> Start with ${units}. ${go ? `Go signal — ${go}.` : ''} ${kill ? `Kill signal — ${kill}.` : ''}</p>

${gate  ? `<p><strong>Scale gate:</strong> ${gate}</p>` : ''}
${move  ? `<p><strong>Your one move right now:</strong> ${move}</p>` : ''}

<p>When you are ready to take the next step, your panel is here: <a href="${panel}" style="color:#5a52c7">${panel}</a></p>

<p>Reply to this email if you want to talk through anything. I am around.</p>

<p>— Alex<br>Make Your Label</p>

</div>`;

  await _send({
    from:     FROM,
    to,
    reply_to: 'alex@makeyourlabel.com',
    subject:  `${fn}, here is your brand blueprint`,
    html,
  });
}

async function sendWelcomeEmail({ to, name, tier, credit }) {
  const isPro = tier === 'pro';
  await _send({
    reply_to: 'alex@makeyourlabel.com',
    headers: {
      'List-Unsubscribe':      `<mailto:unsubscribe@makeyourlabel.com?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
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
  await _send({
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
