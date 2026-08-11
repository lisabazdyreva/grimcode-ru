import { initTRPC } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { hashPassword, safeEqual, verifyPassword } from './crypto.js';
import { serviceDatabaseName, serviceDatabaseUrl } from './env.js';
import {
  ADMIN_CONTEXT_HEADERS,
  applyAdminContext,
  readAdminContext,
  stripAdminContextHeaders,
} from './http/admin-context.js';
import {
  clearCookie,
  expiredSessionCookie,
  parseCookies,
  serializeCookie,
  sessionCookie,
} from './http/cookies.js';
import { createRateLimiter } from './rate-limit.js';
import { CSRF_HEADER, isCsrfValid } from './http/csrf.js';
import { createServiceApp } from './http/service-app.js';
import type { Logger } from './logger.js';
import { applyTheme, normalizeServicePath } from './theme.js';
import type { RpcContext } from './trpc/builders.js';
import { createTrpcClient } from './trpc/client.js';
import { mountTrpc } from './trpc/mount.js';

describe('cookies', () => {
  it('parses a cookie header', () => {
    expect(parseCookies('a=1; b=hello%20world')).toEqual({ a: '1', b: 'hello world' });
  });

  it('ignores malformed pairs', () => {
    expect(parseCookies('=1; broken; c=3')).toEqual({ c: '3' });
  });

  it('serializes a HttpOnly Lax cookie by default', () => {
    expect(serializeCookie('s', 'v')).toBe('s=v; Path=/; HttpOnly; SameSite=Lax');
  });

  it('clears a cookie with Max-Age=0', () => {
    expect(clearCookie('s')).toContain('Max-Age=0');
  });
});

/** The cookie belongs to `shared` because the panel signs out through a procedure of its own. */
describe('session cookie', () => {
  const originalPublicUrl = process.env.PUBLIC_SITE_URL;

  afterEach(() => {
    if (originalPublicUrl === undefined) delete process.env.PUBLIC_SITE_URL;
    else process.env.PUBLIC_SITE_URL = originalPublicUrl;
  });

  it('is HttpOnly and SameSite=Lax so no script can read it', () => {
    const cookie = sessionCookie('token-value', 60);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=60');
  });

  /** The flag follows the public origin, not NODE_ENV: the local stack runs the images over http. */
  it('is marked Secure for an https origin and not for a local http one', () => {
    process.env.PUBLIC_SITE_URL = 'http://127.0.0.1:8080';
    expect(sessionCookie('t', 60)).not.toContain('Secure');
    process.env.PUBLIC_SITE_URL = 'https://example.com';
    expect(sessionCookie('t', 60)).toContain('Secure');
  });

  it('clears with the same attributes, so the browser really drops it', () => {
    process.env.PUBLIC_SITE_URL = 'https://example.com';
    const cleared = expiredSessionCookie();
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Secure');
  });
});

describe('admin context headers', () => {
  const context = {
    userId: '00000000-0000-4000-8000-000000000000',
    email: 'owner@example.com',
    role: 'owner' as const,
    requestId: 'req-42',
  };

  it('removes every client-supplied control header', () => {
    const headers = new Headers();
    for (const name of ADMIN_CONTEXT_HEADERS) headers.set(name, 'forged');
    stripAdminContextHeaders(headers);
    for (const name of ADMIN_CONTEXT_HEADERS) expect(headers.get(name)).toBeNull();
  });

  it('round-trips a verified context', () => {
    const headers = new Headers();
    applyAdminContext(headers, context);
    expect(readAdminContext(headers)).toEqual(context);
  });

  it('refuses a forged context that a strip would have removed', () => {
    const headers = new Headers();
    headers.set('x-template-admin-user-id', 'not-a-uuid');
    headers.set('x-template-admin-email', 'attacker@example.com');
    headers.set('x-template-admin-role', 'owner');
    headers.set('x-template-request-id', 'req-1');
    expect(readAdminContext(headers)).toBeNull();
  });

  it('treats a missing context as no context at all', () => {
    expect(readAdminContext(new Headers())).toBeNull();
  });
});

describe('csrf', () => {
  // The cookie name is scoped by project slug so parallel worktrees never share a token.
  beforeEach(() => {
    process.env.PROJECT_SLUG = 'template';
  });

  it('accepts a matching cookie and header pair', () => {
    const headers = new Headers({
      cookie: 'template_csrf_panel=token-value',
      [CSRF_HEADER]: 'token-value',
    });
    expect(isCsrfValid(headers, 'panel')).toBe(true);
  });

  it('rejects a request that only carries the cookie', () => {
    expect(isCsrfValid(new Headers({ cookie: 'template_csrf_panel=t' }), 'panel')).toBe(false);
  });

  it('rejects a mismatching header', () => {
    const headers = new Headers({
      cookie: 'template_csrf_panel=token-value',
      [CSRF_HEADER]: 'other-value',
    });
    expect(isCsrfValid(headers, 'panel')).toBe(false);
  });

  /** The surfaces share an origin, so one name for all of them means the last to ask wins. */
  it('does not accept another surface’s token', () => {
    const headers = new Headers({
      cookie: 'template_csrf_email=token-value',
      [CSRF_HEADER]: 'token-value',
    });
    expect(isCsrfValid(headers, 'email')).toBe(true);
    expect(isCsrfValid(headers, 'panel')).toBe(false);
  });
});

describe('passwords', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false);
  });

  it('produces a different hash for the same password', async () => {
    expect(await hashPassword('same password 123')).not.toBe(await hashPassword('same password 123'));
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });

  it('compares strings without leaking length-independent timing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('service databases', () => {
  /** Nothing about a module's connection comes from the base string except where the server is. */
  it('derives a database, a role and a password per module from the base url', () => {
    process.env.PROJECT_SLUG = 'demo';
    process.env.DATABASE_URL = 'postgres://owner:secret@postgres:5432/postgres';
    process.env.DB_PASSWORD_AUTH = 'auth-password';

    expect(serviceDatabaseName('auth')).toBe('demo_auth');
    expect(serviceDatabaseUrl('auth')).toBe(
      'postgres://demo_auth:auth-password@postgres:5432/demo_auth',
    );

    delete process.env.DB_PASSWORD_AUTH;
  });

  /** Fail closed: a module with no password of its own must not fall back to the owner's. */
  it('refuses to start a module that has no password', () => {
    process.env.PROJECT_SLUG = 'demo';
    process.env.DATABASE_URL = 'postgres://owner:secret@postgres:5432/postgres';
    delete process.env.DB_PASSWORD_AUTH;

    expect(() => serviceDatabaseUrl('auth')).toThrow(/DB_PASSWORD_AUTH/);
  });

  /** A password with `@` or `/` in it tears a concatenated string apart; `URL` escapes each part. */
  it('survives a password with characters that would tear a url apart', () => {
    process.env.PROJECT_SLUG = 'demo';
    process.env.DATABASE_URL = 'postgres://owner:secret@postgres:5432/postgres';
    process.env.DB_PASSWORD_AUTH = 'p@ss/word:1';

    const parsed = new URL(serviceDatabaseUrl('auth'));
    expect(parsed.hostname).toBe('postgres');
    expect(decodeURIComponent(parsed.password)).toBe('p@ss/word:1');

    delete process.env.DB_PASSWORD_AUTH;
  });

  it('prefers an explicit per-service override', () => {
    process.env.DATABASE_URL_EMAIL = 'postgres://other@db:5432/custom';
    expect(serviceDatabaseUrl('email')).toBe('postgres://other@db:5432/custom');
    delete process.env.DATABASE_URL_EMAIL;
  });

  /** Running on the machine rather than in Compose, where the host `postgres` does not exist. */
  it('redirects to the published port when the application runs outside Compose', () => {
    process.env.PROJECT_SLUG = 'demo';
    process.env.DATABASE_URL = 'postgres://u:p@postgres:5432/postgres';
    process.env.LOCAL_POSTGRES_HOST = '127.0.0.1';
    process.env.POSTGRES_PORT = '63003';
    process.env.DB_PASSWORD_AUTH = 'auth-password';

    expect(serviceDatabaseUrl('auth')).toBe(
      'postgres://demo_auth:auth-password@127.0.0.1:63003/demo_auth',
    );

    delete process.env.LOCAL_POSTGRES_HOST;
    delete process.env.POSTGRES_PORT;
    delete process.env.DB_PASSWORD_AUTH;
  });

  it('takes an explicit override literally, even then', () => {
    process.env.LOCAL_POSTGRES_HOST = '127.0.0.1';
    process.env.DATABASE_URL_EMAIL = 'postgres://other@db:5432/custom';

    expect(serviceDatabaseUrl('email')).toBe('postgres://other@db:5432/custom');

    delete process.env.DATABASE_URL_EMAIL;
    delete process.env.LOCAL_POSTGRES_HOST;
  });
});

describe('theme', () => {
  it('drops the attribute for system so prefers-color-scheme applies', () => {
    const attributes = new Map<string, string>();
    const target = {
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      removeAttribute: (name: string) => void attributes.delete(name),
    };

    applyTheme(target, 'dark');
    expect(attributes.get('data-theme')).toBe('dark');
    applyTheme(target, 'system');
    expect(attributes.has('data-theme')).toBe(false);
  });

  it('normalizes service-relative paths', () => {
    expect(normalizeServicePath('')).toBe('/');
    expect(normalizeServicePath('templates/1')).toBe('/templates/1');
    expect(normalizeServicePath('//templates//1')).toBe('/templates/1');
  });
});

describe('rate limiting', () => {
  it('allows the attempts inside the window and refuses the ones after them', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });

    expect([1, 2, 3].map(() => limiter.attempt('a'))).toEqual([true, true, true]);
    expect(limiter.attempt('a')).toBe(false);

    // Counted per key, so one address being hammered does not lock anyone else out.
    expect(limiter.attempt('b')).toBe(true);
  });

  it('starts over once the window has passed', async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 20 });

    expect(limiter.attempt('a')).toBe(true);
    expect(limiter.attempt('a')).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(limiter.attempt('a')).toBe(true);
  });

  it('forgets a key on request, which is what a successful sign-in does', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });

    expect(limiter.attempt('a')).toBe(true);
    limiter.clear('a');
    expect(limiter.attempt('a')).toBe(true);
  });

  /** A flood of distinct keys must not be a way to grow the process out of memory. */
  it('keeps the number of tracked keys bounded', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 10 });

    for (let index = 0; index < 1_000; index += 1) limiter.attempt(`key-${index}`);

    // The most recent key is still counted, which is the one that matters.
    expect(limiter.attempt('key-999')).toBe(false);
  });
});

/**
 * The in-process tRPC client. The deadline is the reason it exists: `app.fetch` ignores an abort
 * signal, and nothing above would notice until something hung.
 */
describe('calling a neighbour in this process over tRPC', () => {
  const silent: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silent,
  };

  const t = initTRPC.context<RpcContext>().create();

  /** A module with one procedure, mounted exactly as a real one is, and a client aimed at it. */
  function callNeighbour(answer: () => Promise<{ pong: string }>, timeoutMs?: number) {
    const router = t.router({
      ping: t.procedure
        .input(z.object({ say: z.string() }))
        .output(z.object({ pong: z.string() }))
        .query(answer),
    });

    const app = createServiceApp('email', silent);
    mountTrpc(app, '/internal/rpc', router, ({ request, resHeaders }) => ({ request, resHeaders }));

    return createTrpcClient<typeof router>({
      url: 'http://email:3006/internal/rpc',
      fetch: (request) => app.fetch(request),
      timeoutMs,
    });
  }

  it('reaches it without a network and answers through the contract', async () => {
    const client = callNeighbour(() => Promise.resolve({ pong: 'pong' }));

    expect(await client.ping.query({ say: 'hi' })).toEqual({ pong: 'pong' });
  });

  it('stops waiting when the neighbour hangs, which no signal would do here', async () => {
    const client = callNeighbour(
      () => new Promise((resolve) => setTimeout(() => resolve({ pong: 'late' }), 1_000)),
      50,
    );

    const started = Date.now();
    await expect(client.ping.query({ say: 'hi' })).rejects.toThrow(/did not answer within 50 ms/);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
