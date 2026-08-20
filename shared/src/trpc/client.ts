import { createTRPCClient, httpLink, type TRPCClient, type TRPCLink } from '@trpc/client';
import type { AnyTRPCRouter } from '@trpc/server';

import { RPC_TIMEOUT_MS, withDeadline, type FetchLike } from '../rpc.js';

export interface TrpcClientOptions {
  /** Absolute URL of the tRPC mount, for example `http://email:3006/internal/rpc`. */
  url: string;
  /** Extra headers sent with every call, such as the propagated request id. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Who answers the call; omitted means the network. In this process it is the neighbour's own
   * `app.fetch`, and the `url` still builds the request that nobody dials.
   */
  fetch?: FetchLike;
}

/**
 * Typed tRPC client for one module calling another.
 *
 * The type comes from the neighbour's router, through its `./contract` export.
 *
 * **`httpLink`, never `httpBatchLink`.** The batching link is the one tRPC's own documentation
 * recommends by default, and it answers a batch of mixed results with 207. Everything above this —
 * the fail-closed branches, `ServiceUnavailableError`, the acceptance suite — is written around one
 * call having one status.
 *
 * **The deadline is ours to enforce.** `AbortSignal` is honoured by the network and ignored by
 * `app.fetch`, so in one process a hung handler would otherwise be waited on forever — and every
 * fail-closed branch above this depends on the wait actually ending.
 */
export function createTrpcClient<TRouter extends AnyTRPCRouter>(
  options: TrpcClientOptions,
): TRPCClient<TRouter> {
  const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;
  const answer = options.fetch;

  const link = httpLink({
    url: options.url,
    methodOverride: 'POST',
    headers: () => options.headers ?? {},
    fetch: answer
      ? (input, init) =>
          withDeadline(
            answer(new Request(input as string | URL | Request, init as RequestInit)),
            options.url,
            timeoutMs,
          )
      : (input, init) => {
          /*
           * The link's own signal is kept rather than replaced: tRPC aborts a call the caller gave
           * up on through `init.signal`, and overwriting it would leave that request running to its
           * end with nobody left to read it.
           */
          const request = init as RequestInit | undefined;
          const deadline = AbortSignal.timeout(timeoutMs);
          return fetch(input as string | URL | Request, {
            ...request,
            signal: request?.signal ? AbortSignal.any([request.signal, deadline]) : deadline,
          });
        },
  });

  /*
   * The one cast in this file, and it is about a transformer nothing here has. `httpLink`'s options
   * resolve `TransformerOptions<…>` off the router's own types — with a transformer one must be
   * given, without one it is forbidden — and while `TRouter` is generic the compiler cannot tell
   * which case it is looking at, so it accepts neither. No module here configures a transformer.
   */
  return createTRPCClient<TRouter>({ links: [link as TRPCLink<TRouter>] });
}
