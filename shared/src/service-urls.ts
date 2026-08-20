import { optionalEnv } from './env.js';

/**
 * Every name this template gives a service. A name and nothing else: the modules share one process,
 * and a neighbour is reached through the `fetch` its caller was handed, never through an address.
 *
 * `adminer` is on the list because Gateway routes to it as if it were a service, and it is the one
 * target that really does live somewhere else.
 */
export type InternalServiceName =
  | 'gateway'
  | 'site'
  | 'app'
  | 'admin'
  | 'auth'
  | 'users'
  | 'notifications'
  | 'email'
  | 'adminer';

/** Port inside the container, and the port Adminer answers on in its own. */
const CONTAINER_PORT = 8080;

/**
 * Where the database browser answers: its own container, so this one is dialled for real.
 * `SERVICE_URL_ADMINER` is the only address override left that does anything.
 */
export function adminerUrl(): string {
  return optionalEnv('SERVICE_URL_ADMINER', `http://adminer:${CONTAINER_PORT}`);
}

