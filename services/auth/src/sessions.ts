import { intEnv, newToken } from '@template/shared';

export const SESSION_TTL_SECONDS = () => intEnv('AUTH_SESSION_TTL_SECONDS', 60 * 60 * 24 * 30);

export function newSessionToken(): string {
  return newToken(32);
}
