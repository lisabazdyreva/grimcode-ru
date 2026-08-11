import { verifyPassword } from '@template/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { DUMMY_PASSWORD_HASH } from './routers/public.js';
import { SESSION_TTL_SECONDS } from './sessions.js';

afterEach(() => {
  delete process.env.AUTH_SESSION_TTL_SECONDS;
});

// The cookie itself is `shared`'s: Auth is not the only surface that ends a session. Its checks
// live next to it, in `shared/src/shared.test.ts`.
describe('session lifetime', () => {
  it('defaults to a 30 day lifetime and honours an override', () => {
    expect(SESSION_TTL_SECONDS()).toBe(60 * 60 * 24 * 30);
    process.env.AUTH_SESSION_TTL_SECONDS = '3600';
    expect(SESSION_TTL_SECONDS()).toBe(3600);
  });
});

describe('login timing defence', () => {
  /**
   * When no identity matches, login still verifies this fixed hash so that a wrong address and a
   * wrong password take comparable time. If it ever stopped being a parseable hash, the work would
   * be skipped and login would become an existence oracle again.
   */
  it('is a parseable hash that never matches and never throws', async () => {
    await expect(verifyPassword('anything at all', DUMMY_PASSWORD_HASH)).resolves.toBe(false);
    await expect(verifyPassword('', DUMMY_PASSWORD_HASH)).resolves.toBe(false);
  });

  it('costs real work rather than returning early on a malformed value', async () => {
    const [scheme, salt, key] = DUMMY_PASSWORD_HASH.split('$');
    expect(scheme).toBe('scrypt');
    expect(salt).toHaveLength(32);
    expect(key).toHaveLength(128);
  });
});
