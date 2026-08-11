import type {
  adminInternalContract,
  AdminTarget,
  AuthorizationResult,
  ContractRouterClient,
} from '@template/contracts';
import {
  createRpcClient,
  internalServiceUrl,
  parseCookies,
  REQUEST_ID_HEADER,
  ServiceUnavailableError,
  sessionCookieName,
  type FetchLike,
} from '@template/shared';


type AdminInternalClient = ContractRouterClient<typeof adminInternalContract>;


/**
 * The whole admin check is one internal Admin method.
 *
 * Gateway computes nothing itself, keeps no copy of the rights and caches no result, which is why
 * a changed grant takes effect on the very next request.
 *
 * This is the hottest call in the template — every `/admin/**` request waits on it — and the one
 * that most needs the deadline `createRpcClient` puts around it: in this process nothing else
 * bounds the wait, and without a bound the fail-closed branch below would simply never be reached.
 */
export async function authorizeAdminRequest(
  request: Request,
  target: AdminTarget,
  requestId: string,
  callAdmin: FetchLike,
): Promise<AuthorizationResult> {
  const sessionToken = parseCookies(request.headers.get('cookie'))[sessionCookieName()] ?? null;

  const client: AdminInternalClient = createRpcClient({
    url: `${internalServiceUrl('admin')}/internal/rpc`,
    headers: { [REQUEST_ID_HEADER]: requestId },
    fetch: callAdmin,
  });

  try {
    return await client.authorize({ sessionToken, target });
  } catch (error) {
    // Admin being unreachable — or Auth being unreachable behind it — is an infrastructure
    // failure. Reporting it as "no rights" would hide an outage, so it fails closed instead.
    throw new ServiceUnavailableError('admin', error);
  }
}
