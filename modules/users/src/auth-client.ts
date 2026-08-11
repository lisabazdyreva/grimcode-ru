import type { AuthInternalRouter } from '@template/auth/contract';
import type { Identity } from '@template/contracts';
import {
  createTrpcClient,
  internalServiceUrl,
  parseCookies,
  REQUEST_ID_HEADER,
  sessionCookieName,
  type FetchLike,
} from '@template/shared';

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
  callAuth: FetchLike,
): Promise<Identity | null> {
  const token = parseCookies(request.headers.get('cookie'))[sessionCookieName()];
  if (!token) return null;

  const auth = createTrpcClient<AuthInternalRouter>({
    url: `${internalServiceUrl('auth')}/internal/rpc`,
    headers: { [REQUEST_ID_HEADER]: requestId },
    fetch: callAuth,
  });

  const { identity } = await auth.resolveSession.query({ sessionToken: token });
  return identity;
}
