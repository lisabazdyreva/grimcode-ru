import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';

/**
 * Something that answers a request: the global `fetch` over the network, or a module's own
 * `app.fetch` in the same process.
 */
export type FetchLike = (request: Request) => Promise<Response> | Response;

export interface RpcClientOptions {
  /** Absolute URL of the RPC mount, for example `http://auth:3003/internal/rpc`. */
  url: string;
  /** Extra headers sent with every call, such as the propagated request id. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Who answers the call. Omitted means the network.
   *
   * When the neighbour lives in this process, the composer passes its `app.fetch` here. The `url`
   * still matters — the request is built from it and routing goes by path — but nobody dials it.
   */
  fetch?: FetchLike;
}

/** Error a call gets when the neighbour did not answer within the deadline. */
export class RpcTimeoutError extends Error {
  constructor(
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`Call to ${url} did not answer within ${timeoutMs} ms`);
    this.name = 'RpcTimeoutError';
  }
}

/**
 * Stops waiting after `timeoutMs`.
 *
 * Over the network `AbortSignal.timeout` does this and also cancels the request. In the same
 * process it does neither: a handler that hangs is never interrupted, and a signal passed to
 * `app.fetch` is ignored — measured, a 1500 ms handler under a 200 ms limit returned after 1512 ms
 * with no error at all. So the deadline is ours to enforce, and what it buys is exactly one thing:
 * the caller stops waiting. The handler keeps running to its end; nothing can take that back.
 *
 * Without this, `ServiceUnavailableError` would stop happening where it used to — every
 * `/admin/**` request depends on it, and so does the page of profiles in Users.
 */
async function withDeadline<T>(work: Promise<T> | T, url: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RpcTimeoutError(url, timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Typed oRPC client.
 *
 * The caller supplies the client type derived from a contract, for example
 * `ContractRouterClient<typeof authInternalContract>`, so a call site can never drift from the
 * contract it targets.
 */
export function createRpcClient<T>(options: RpcClientOptions): T {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const answer = options.fetch;

  const link = new RPCLink({
    url: options.url,
    headers: () => options.headers ?? {},
    fetch: answer
      ? (request) => withDeadline(answer(request as Request), options.url, timeoutMs)
      : (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  });
  return createORPCClient(link) as T;
}

/**
 * Error thrown when a dependency of an authorization decision is unreachable.
 *
 * Callers must translate it into a fail-closed service-unavailable response instead of hiding an
 * infrastructure failure behind "no rights".
 */
export class ServiceUnavailableError extends Error {
  constructor(
    readonly service: string,
    readonly reason: unknown,
  ) {
    super(`Service ${service} is unavailable`);
    this.name = 'ServiceUnavailableError';
  }
}
