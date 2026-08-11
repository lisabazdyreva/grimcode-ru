/** What a call to a neighbour needs, whichever RPC library carries it. */

/** Answers a request: the global `fetch`, or a module's own `app.fetch` in the same process. */
export type FetchLike = (request: Request) => Promise<Response> | Response;

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
 * Over the network `AbortSignal.timeout` does this and also cancels the request; through `app.fetch`
 * a signal is ignored — measured, a 1500 ms handler under a 200 ms limit returned after 1512 ms with
 * no error at all. What it buys is that the caller stops waiting, which is what every fail-closed
 * branch above depends on.
 */
export async function withDeadline<T>(
  work: Promise<T> | T,
  url: string,
  timeoutMs: number,
): Promise<T> {
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
