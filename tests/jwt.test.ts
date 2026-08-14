import { describe, expect, it } from 'vitest';
import { signHs256Jwt, userIdFromSignedAccessToken } from '../supabase/functions/_shared/jwt.ts';

const secret = 'test-jwt-secret-for-local-verify';

describe('userIdFromSignedAccessToken', () => {
  it('returns the subject for a valid authenticated token', async () => {
    const token = await signHs256Jwt(
      {
        sub: '11111111-1111-1111-1111-111111111111',
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600
      },
      secret
    );
    await expect(userIdFromSignedAccessToken(token, secret)).resolves.toBe(
      '11111111-1111-1111-1111-111111111111'
    );
  });

  it('rejects anon tokens and expired tokens', async () => {
    const anon = await signHs256Jwt(
      { role: 'anon', exp: Math.floor(Date.now() / 1000) + 3600 },
      secret
    );
    const expired = await signHs256Jwt(
      {
        sub: '11111111-1111-1111-1111-111111111111',
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) - 10
      },
      secret
    );
    await expect(userIdFromSignedAccessToken(anon, secret)).resolves.toBeNull();
    await expect(userIdFromSignedAccessToken(expired, secret)).resolves.toBeNull();
    await expect(userIdFromSignedAccessToken('not-a-jwt', secret)).resolves.toBeNull();
  });
});
