// Vercel serverless function — saves waitlist signups to Neon Postgres
// and sends emails via Resend (admin notification + subscriber confirmation).
//
// Setup (one time):
//   1. Vercel → project → Storage → Create Database → Neon. Connect it (injects DATABASE_URL).
//   2. Resend (resend.com): create an API key, and verify the sending domain `kyrios.run`
//      (add the SPF/DKIM DNS records Resend shows you, at Spaceship).
//   3. Vercel → project → Settings → Environment Variables, add:
//        RESEND_API_KEY = re_xxx           (required for emails)
//        RESEND_FROM    = Kyrios <hello@kyrios.run>   (optional, must be on a verified domain)
//        ADMIN_EMAIL    = hamzaa@logicbase.io          (optional, defaults below)
//   4. Redeploy. Table auto-creates on first signup.
//
// Query leads: Vercel → Storage → Neon → SQL editor →
//   select * from waitlist order by created_at desc;

import { neon } from '@neondatabase/serverless';

const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.DATABASE_URL_UNPOOLED;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.RESEND_FROM || 'Kyrios <hello@kyrios.run>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'hamzaa@logicbase.io';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!connectionString) {
    console.error('waitlist: no database connection string in env');
    return res.status(500).json({ ok: false, error: 'Database not configured' });
  }

  try {
    const body =
      typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // Honeypot — bots fill the hidden `company_url` field. Silently accept & drop.
    if ((body.company_url || '').trim()) return res.status(200).json({ ok: true });

    const name = String(body.name || '').trim().slice(0, 200);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 320);
    const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
    if (!name || !emailOk) {
      return res.status(400).json({ ok: false, error: 'Name and a valid email are required.' });
    }

    const clip = (v, n = 200) => (v == null ? null : String(v).trim().slice(0, n) || null);
    const lead = {
      name, email,
      company: clip(body.company), role: clip(body.role, 120),
      phone: clip(body.phone, 40), country: clip(body.country, 80),
      source: clip(body.source, 80) || 'landing',
    };

    const sql = neon(connectionString);

    await sql`
      CREATE TABLE IF NOT EXISTS waitlist (
        id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email       text UNIQUE NOT NULL,
        name        text NOT NULL,
        company     text,
        role        text,
        phone       text,
        country     text,
        source      text,
        user_agent  text,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )`;

    const rows = await sql`
      INSERT INTO waitlist (email, name, company, role, phone, country, source, user_agent)
      VALUES (
        ${lead.email}, ${lead.name}, ${lead.company}, ${lead.role},
        ${lead.phone}, ${lead.country}, ${lead.source}, ${clip(req.headers['user-agent'], 400)}
      )
      ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name, company = EXCLUDED.company, role = EXCLUDED.role,
        phone = EXCLUDED.phone, country = EXCLUDED.country, source = EXCLUDED.source,
        updated_at = now()
      RETURNING (xmax = 0) AS is_new`;

    const isNew = rows?.[0]?.is_new !== false;

    // Only email genuinely new signups (skip duplicate re-submits). Never fail the
    // request because of an email problem — the lead is already saved.
    if (isNew) {
      try { await sendEmails(lead); }
      catch (e) { console.error('waitlist: email send error:', e); }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('waitlist error:', err);
    return res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
}

// ---------------------------------------------------------------- emails

async function resendSend(payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json().catch(() => ({}));
}

async function sendEmails(d) {
  if (!RESEND_API_KEY) { console.warn('waitlist: RESEND_API_KEY not set — skipping emails'); return; }
  const firstName = (d.name || '').trim().split(/\s+/)[0] || 'there';

  const results = await Promise.allSettled([
    resendSend({
      from: FROM,
      to: [ADMIN_EMAIL],
      reply_to: d.email,
      subject: `🎯 New Kyrios waitlist signup — ${d.name}`,
      html: adminHtml(d),
      text: adminText(d),
    }),
    resendSend({
      from: FROM,
      to: [d.email],
      reply_to: ADMIN_EMAIL,
      subject: `You're in — your early access to Kyrios is reserved`,
      html: subscriberHtml(firstName),
      text: subscriberText(firstName),
    }),
  ]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`waitlist: email #${i === 0 ? 'admin' : 'subscriber'} failed:`, r.reason);
  });
}

const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function adminHtml(d) {
  const row = (label, val) =>
    `<tr>
       <td style="padding:8px 12px;border:1px solid #e8e6dd;background:#f4f3ee;font-weight:600;white-space:nowrap;color:#1f3d2b">${label}</td>
       <td style="padding:8px 12px;border:1px solid #e8e6dd">${esc(val) || '<span style="color:#999">—</span>'}</td>
     </tr>`;
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:580px;margin:0 auto;color:#1a1a1a">
    <h2 style="font-size:18px;margin:0 0 4px">🎯 New Kyrios waitlist signup</h2>
    <p style="color:#666;margin:0 0 18px;font-size:14px">${esc(d.name)} just requested early access.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      ${row('Name', d.name)}
      ${row('Email', d.email)}
      ${row('Company', d.company)}
      ${row('Role', d.role)}
      ${row('Phone', d.phone)}
      ${row('Country', d.country)}
      ${row('Source', d.source)}
    </table>
    <p style="color:#999;margin:18px 0 0;font-size:12px">Reply to this email to reach ${esc(d.name)} directly — Kyrios waitlist · kyrios.run</p>
  </div>`;
}

function adminText(d) {
  return `New Kyrios waitlist signup\n\n` +
    `Name:    ${d.name}\n` +
    `Email:   ${d.email}\n` +
    `Company: ${d.company || '-'}\n` +
    `Role:    ${d.role || '-'}\n` +
    `Phone:   ${d.phone || '-'}\n` +
    `Country: ${d.country || '-'}\n` +
    `Source:  ${d.source || '-'}\n\n` +
    `Reply to this email to reach them directly.`;
}

function subscriberHtml(firstName) {
  return `<div style="background:#fafaf7;padding:32px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e8e6dd;border-radius:6px;overflow:hidden">
      <div style="background:#1f3d2b;padding:18px 28px">
        <span style="color:#fafaf7;font-size:20px;font-weight:700;letter-spacing:.4px">kyrios</span>
      </div>
      <div style="padding:30px 28px 8px">
        <h1 style="font-size:22px;line-height:1.3;margin:0 0 16px;color:#142a1d">You're on the list, ${esc(firstName)} 🎯</h1>
        <p style="font-size:15px;line-height:1.6;color:#333;margin:0 0 16px">
          Thanks for requesting early access to <strong>Kyrios</strong> — your spot is reserved.
        </p>
        <p style="font-size:15px;line-height:1.6;color:#333;margin:0 0 16px">
          Kyrios is the lead engine that replaces the grind of prospecting: it hunts your next
          customers from Google Maps, LinkedIn, job boards and Reddit, scores every one against
          your ICP with AI, and writes the cold outreach — all from one app that runs on your own machine.
        </p>
        <p style="font-size:15px;line-height:1.6;color:#333;margin:0 0 10px"><strong>What happens next:</strong></p>
        <ul style="font-size:15px;line-height:1.7;color:#333;margin:0 0 18px;padding-left:20px">
          <li>We're onboarding early operators in small batches.</li>
          <li>When your seat opens, you'll get your download + setup link from us.</li>
          <li>Your first hunts are on us.</li>
        </ul>
        <p style="font-size:15px;line-height:1.6;color:#333;margin:0 0 16px">
          In the meantime, do me one favour: <strong>hit reply and tell me what your outbound looks like today.</strong>
          It helps us get you set up faster — and I read every reply.
        </p>
        <p style="font-size:15px;line-height:1.6;color:#333;margin:22px 0 0">
          Talk soon,<br>
          <strong>Hamza</strong><br>
          <span style="color:#777">Founder, Logicbase</span>
        </p>
      </div>
      <div style="padding:16px 28px;border-top:1px solid #e8e6dd;color:#999;font-size:12px">
        <a href="https://kyrios.run" style="color:#1f3d2b;text-decoration:none;font-weight:600">kyrios.run</a>
        &nbsp;·&nbsp; You're receiving this because you signed up for Kyrios early access.
      </div>
    </div>
  </div>`;
}

function subscriberText(firstName) {
  return `You're on the list, ${firstName}.\n\n` +
    `Thanks for requesting early access to Kyrios — your spot is reserved.\n\n` +
    `Kyrios is the lead engine that replaces the grind of prospecting: it hunts your next ` +
    `customers from Google Maps, LinkedIn, job boards and Reddit, scores every one against your ` +
    `ICP with AI, and writes the cold outreach — all from one app that runs on your own machine.\n\n` +
    `What happens next:\n` +
    `- We're onboarding early operators in small batches.\n` +
    `- When your seat opens, you'll get your download + setup link from us.\n` +
    `- Your first hunts are on us.\n\n` +
    `In the meantime, do me one favour: hit reply and tell me what your outbound looks like ` +
    `today. It helps us get you set up faster — and I read every reply.\n\n` +
    `Talk soon,\nHamza\nFounder, Logicbase\nkyrios.run`;
}
