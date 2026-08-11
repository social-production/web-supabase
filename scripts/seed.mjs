/**
 * Minimal seed for local Supabase.
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env or .env.local.
 *
 * Creates a demo user via Auth Admin API and public profile row (trigger also runs).
 * The Platform channel is seeded by migration 20260806000005_seed_platform_channel.sql
 * (applied during `npm run db:reset`), not by this script.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvLocal() {
  const path = resolve(process.cwd(), '.env.local');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvLocal();

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see docs/ENV.md)');
  process.exit(1);
}

const email = process.env.SEED_EMAIL ?? 'demo@socialproduction.local';
const password = process.env.SEED_PASSWORD ?? 'DemoPass123!';
const username = process.env.SEED_USERNAME ?? 'demo';

const res = await fetch(`${url}/auth/v1/admin/users`, {
  method: 'POST',
  headers: {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    email,
    password,
    email_confirm: true,
    user_metadata: { username, profile_bio: 'Seeded demo user' }
  })
});

const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error('Seed failed', res.status, body);
  process.exit(1);
}

console.log('Seeded auth user', { id: body.id, email, username, password });
