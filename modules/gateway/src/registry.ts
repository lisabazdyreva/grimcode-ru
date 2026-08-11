import { internalServiceUrl, type FetchLike } from '@template/shared';

import type { ProxyTarget } from './proxy.js';

/**
 * Gateway's own explicit allowlists. A `:name` from the URL is only ever a key of these maps, so an
 * unknown name has no entry and nothing is routed. `check-service-ids.mjs` reconciles them with the
 * Admin shell's list and reads them as text — they have to stay literals with one key per line.
 */

/** `/service/:name/**` — no admin check. Securing these endpoints is the module's own job. */
export const PUBLIC_SERVICES = {
  auth: true,
  users: true,
} as const satisfies Record<string, true>;

export type PublicServiceName = keyof typeof PUBLIC_SERVICES;

/**
 * `/admin/embed/service/:name/**` — reachable only after Admin allowed the request.
 */
export const ADMIN_SERVICES = {
  auth: true,
  users: true,
  notifications: true,
  email: true,
} as const satisfies Record<string, true>;

export type AdminServiceName = keyof typeof ADMIN_SERVICES;

/**
 * Everything Gateway can route to. A target may be an application in this process or a URL — Gateway
 * routes by path and forwards the request unchanged — which keeps the door open both ways: Adminer
 * is a URL today, and a module moved back out into a service becomes one. `admin` is narrower on
 * purpose: Gateway calls it on every `/admin/**` request to ask whether it is allowed at all.
 */
export interface GatewayTargets extends Record<AdminServiceName | PublicServiceName, ProxyTarget> {
  site: ProxyTarget;
  app: ProxyTarget;
  admin: FetchLike;
}

/**
 * The database browser behind the panel's own database area. Not in `ADMIN_SERVICES` because it is
 * not a module of this template but a third-party application the panel embeds, reading every
 * module's data at once — and the one target still reached over a real network, in its own
 * container. Gateway knows where it lives; Admin decides who may reach it.
 */
export function databaseBrowserUrl(): string {
  return internalServiceUrl('adminer');
}

export function isPublicService(name: string): name is PublicServiceName {
  return Object.hasOwn(PUBLIC_SERVICES, name);
}

export function isAdminService(name: string): name is AdminServiceName {
  return Object.hasOwn(ADMIN_SERVICES, name);
}
