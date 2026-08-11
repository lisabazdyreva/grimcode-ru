import { createTRPCClient, httpLink } from '@trpc/client';

import type { AuthAdminRouter } from '@template/auth/contract';

/**
 * Client for this module's own admin API.
 *
 * The call goes through Gateway, which has already checked the session, the admin role and the
 * grant on Auth. Operations that change something also carry a CSRF token this module issued —
 * under its own scope, so a token minted for the shell is refused here.
 *
 * The token goes with exactly what changes something, because the link knows the operation's type.
 */
const BASE = '/admin/embed/service/auth';

const link = httpLink({
  url: `${window.location.origin}${BASE}/rpc`,
  // Queries travel as POST too: bodies stay out of URLs, and out of the caches a GET invites.
  methodOverride: 'POST',
  fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
  headers: async (options) =>
    options.op.type === 'mutation' ? { 'x-csrf-token': await csrfToken() } : {},
});

let cached: Promise<string> | null = null;

async function csrfToken(): Promise<string> {
  cached ??= fetch(`${BASE}/csrf`, { credentials: 'same-origin' })
    .then((response) => {
      if (!response.ok) throw new Error('The CSRF token could not be obtained');
      return response.json() as Promise<{ token: string }>;
    })
    .then((body) => body.token)
    .catch((error: unknown) => {
      // A failed fetch must not poison every later mutation.
      cached = null;
      throw error;
    });

  return cached;
}

export const api = createTRPCClient<AuthAdminRouter>({ links: [link] });

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
