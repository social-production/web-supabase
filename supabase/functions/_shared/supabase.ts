import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { userIdFromSignedAccessToken } from './jwt.ts';

export function createServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? Deno.env.get('SB_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SB_SERVICE_ROLE_KEY') ?? '';
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

export function createUserClient(authHeader: string | null): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? Deno.env.get('SB_URL') ?? '';
  const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SB_ANON_KEY') ?? '';
  if (!url || !anon) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
  }
  return createClient(url, anon, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {}
    },
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

export async function requireUserId(
  service: SupabaseClient,
  authHeader: string | null
): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length);
  const secret =
    Deno.env.get('SUPABASE_JWT_SECRET') ?? Deno.env.get('JWT_SECRET') ?? '';
  if (secret) {
    return userIdFromSignedAccessToken(token, secret);
  }
  const { data, error } = await service.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}
