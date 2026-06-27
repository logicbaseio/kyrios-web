// Vercel serverless function — saves waitlist signups to Neon Postgres.
//
// Setup (one time):
//   1. Vercel dashboard → your project → Storage → Create Database → Neon (Postgres).
//   2. Connect it to this project. Vercel injects DATABASE_URL automatically.
//   3. Redeploy. The `waitlist` table is created automatically on the first signup.
//
// Query your leads anytime in Vercel → Storage → Neon → SQL editor:
//   select * from waitlist order by created_at desc;

import { neon } from '@neondatabase/serverless';

const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.DATABASE_URL_UNPOOLED;

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

    await sql`
      INSERT INTO waitlist (email, name, company, role, phone, country, source, user_agent)
      VALUES (
        ${email}, ${name}, ${clip(body.company)}, ${clip(body.role, 120)},
        ${clip(body.phone, 40)}, ${clip(body.country, 80)}, ${clip(body.source, 80)},
        ${clip(req.headers['user-agent'], 400)}
      )
      ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name, company = EXCLUDED.company, role = EXCLUDED.role,
        phone = EXCLUDED.phone, country = EXCLUDED.country, source = EXCLUDED.source,
        updated_at = now()`;

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('waitlist error:', err);
    return res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
}
