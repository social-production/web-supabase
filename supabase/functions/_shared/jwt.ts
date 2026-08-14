/**
 * Local HS256 JWT verify for hosted Edge Functions.
 * Avoids a GoTrue getUser round-trip on every gateway request.
 */

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(`${padded}${pad}`);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signHs256Jwt(
  payload: Record<string, unknown>,
  secret: string
): Promise<string> {
  const header = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  );
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(data))
  );
  return `${data}.${bytesToBase64Url(signature)}`;
}

export async function userIdFromSignedAccessToken(
  token: string,
  secret: string
): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || !secret) return null;
  const [header, body, signature] = parts;
  const data = `${header}.${body}`;
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    base64UrlToBytes(signature),
    new TextEncoder().encode(data)
  );
  if (!valid) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body))) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }

  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
    return null;
  }
  if (payload.role && payload.role !== 'authenticated') {
    return null;
  }
  const sub = payload.sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}
