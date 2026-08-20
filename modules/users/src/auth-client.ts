import type { AuthInternalCaller, Identity } from '@template/auth/contract';
import { parseCookies, sessionCookieName } from '@template/shared';

/**
 * Users owns no sessions and does not know the cookie's internal format. It asks Auth over the
 * internal contract on every protected call.
 *
 * A route guard in the SPA is for the user flow only — this server-side check is what actually
 * protects the data.
 */
export async function resolveIdentity(
  request: Request,
  requestId: string,
  callAuth: (call: { requestId: string }) => AuthInternalCaller,
): Promise<Identity | null> {
  const token = parseCookies(request.headers.get('cookie'))[sessionCookieName()];
  if (!token) return null;

  const auth = callAuth({ requestId });

  const { identity } = await auth.resolveSession({ sessionToken: token });
  return identity;
}
