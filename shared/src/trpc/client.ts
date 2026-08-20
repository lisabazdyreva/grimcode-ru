import { createTRPCClient, httpLink, type TRPCClient, type TRPCLink } from '@trpc/client';
import type { AnyTRPCRouter } from '@trpc/server';

import { RPC_TIMEOUT_MS, withDeadline, type FetchLike } from '../rpc.js';

/**
 * The address a request is built from. The host is never dialed — the neighbour's own `app.fetch`
 * answers — but the path is what that neighbour routes on, so it must match the
 * `mountTrpc(app, '/internal/rpc', …)` of every module. Nothing checks that for us.
 */
const INTERNAL_RPC_URL = 'http://module/internal/rpc';

export interface TrpcClientOptions {
  /** Who answers the call: the neighbour's own `app.fetch`, which the caller was handed. */
  fetch: FetchLike;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Typed tRPC client for a call carried as a request; the type comes from the neighbour's
 * `./contract`. No module uses it any more — only the composer, for its one remaining call.
 *
 * **`httpLink`, never `httpBatchLink`.** Batching answers mixed results with a single 207, and the
 * fail-closed branches around here are written around one call having one status.
 *
 * **The deadline is ours.** `app.fetch` ignores `AbortSignal`, so a hung handler would otherwise be
 * waited on forever.
 */
export function createTrpcClient<TRouter extends AnyTRPCRouter>(
  options: TrpcClientOptions,
): TRPCClient<TRouter> {
  const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;

  const link = httpLink({
    url: INTERNAL_RPC_URL,
    methodOverride: 'POST',
    headers: () => options.headers ?? {},
    fetch: (input, init) => {
      const request = new Request(input as string | URL | Request, init as RequestInit);
      // The procedure is the last part of the path, so a deadline names the call it gave up on.
      return withDeadline(options.fetch(request), request.url, timeoutMs);
    },
  });

  /*
   * The cast is about a transformer nothing here has: `httpLink` resolves its options off the
   * router's own types — required with a transformer, forbidden without — and a generic `TRouter`
   * fits neither.
   */
  return createTRPCClient<TRouter>({ links: [link as TRPCLink<TRouter>] });
}
