import { optionalEnv } from './env.js';

/**
 * Fixed internal ports of the template. Most are no longer dialled — the modules share one process,
 * so a neighbour's address is only what a `Request` is built from — and they are kept because they
 * are the escape hatch: point `SERVICE_URL_<MODULE>` at a real address, hand that module's client
 * the network `fetch`, and it moves back out into a service of its own without a code change.
 */
export const INTERNAL_PORTS = {
  gateway: 8080,
  site: 3000,
  app: 3001,
  admin: 3002,
  auth: 3003,
  users: 3004,
  notifications: 3005,
  email: 3006,
  adminer: 8080,
} as const;

export type InternalServiceName = keyof typeof INTERNAL_PORTS;

/** Base URL of another service on the internal network; nothing here is published outwards. */
export function internalServiceUrl(service: InternalServiceName): string {
  return optionalEnv(
    `SERVICE_URL_${service.toUpperCase()}`,
    `http://${service}:${INTERNAL_PORTS[service]}`,
  );
}

/**
 * Port to listen on. Inside the container the fixed internal port is right; outside there is no
 * publishing step, so the application takes `GATEWAY_PORT`, which Compose does not declare to the
 * container. That is what lets two worktrees run at once.
 */
export function ownPort(service: InternalServiceName): number {
  for (const name of service === 'gateway' ? ['PORT', 'GATEWAY_PORT'] : ['PORT']) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return INTERNAL_PORTS[service];
}
