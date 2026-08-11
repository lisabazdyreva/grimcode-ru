import type { AdminInternalRouter } from '@template/admin/contract';
import type { AuthorizationResult } from '@template/admin/contract';
import type { AdminTarget } from '@template/shared/vocabulary';
import {
  createTrpcClient,
  internalServiceUrl,
  parseCookies,
  REQUEST_ID_HEADER,
  ServiceUnavailableError,
  sessionCookieName,
  type FetchLike,
} from '@template/shared';


/**
 * The whole admin check is one internal Admin method.
 *
 * Gateway computes nothing itself and caches no result, which is why a changed grant takes effect on
 * the very next request. It is also the call that most needs the deadline `createTrpcClient` puts
 * around it: nothing else bounds the wait, and the fail-closed branch below would never be reached.
 */
export async function authorizeAdminRequest(
  request: Request,
  target: AdminTarget,
  requestId: string,
  callAdmin: FetchLike,
): Promise<AuthorizationResult> {
  const sessionToken = parseCookies(request.headers.get('cookie'))[sessionCookieName()] ?? null;

  const client = createTrpcClient<AdminInternalRouter>({
    url: `${internalServiceUrl('admin')}/internal/rpc`,
    headers: { [REQUEST_ID_HEADER]: requestId },
    fetch: callAdmin,
  });

  try {
    return await client.authorize.query({ sessionToken, target });
  } catch (error) {
    // Admin being unreachable — or Auth being unreachable behind it — is an infrastructure
    // failure. Reporting it as "no rights" would hide an outage, so it fails closed instead.
    throw new ServiceUnavailableError('admin', error);
  }
}
