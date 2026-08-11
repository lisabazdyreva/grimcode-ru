/**
 * Typed access to the environment.
 *
 * Every value comes from the single root `.env` documented in `.env.example`. A service only ever
 * reads the variables that are declared for it in the Compose file.
 */

export class MissingEnvError extends Error {
  constructor(name: string) {
    super(`Required environment variable ${name} is not set`);
    this.name = 'MissingEnvError';
  }
}

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new MissingEnvError(name);
  return value;
}

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${name} is not an integer`);
  return parsed;
}

export function projectSlug(): string {
  return optionalEnv('PROJECT_SLUG', 'template');
}

export function publicSiteUrl(): string {
  return optionalEnv('PUBLIC_SITE_URL', 'http://127.0.0.1:8080').replace(/\/+$/, '');
}

/**
 * Where PostgreSQL is, when the application runs on the machine instead of in Compose.
 *
 * `DATABASE_URL` names the host `postgres`, which exists only inside the Compose network. The
 * substitution lives here, where every caller passes through, and in Compose the variable is simply
 * not declared to the container — the switch is the declaration, not a flag anybody has to remember.
 */
function withLocalHost(url: URL): URL {
  const host = process.env.LOCAL_POSTGRES_HOST;
  if (host === undefined || host === '') return url;

  url.hostname = host;
  url.port = optionalEnv('POSTGRES_PORT', url.port);
  return url;
}

/**
 * Connection string of one module database. The template uses a single base `DATABASE_URL` and each
 * module with state owns `<PROJECT_SLUG>_<module>` on that server; a deployment that needs different
 * credentials or hosts per module sets `DATABASE_URL_<MODULE>` instead.
 */
export function serviceDatabaseUrl(service: string): string {
  // An explicit override is taken literally, `LOCAL_POSTGRES_HOST` or not: whoever wrote out a
  // whole connection string for one module meant that server, that role and that password.
  const override = process.env[`DATABASE_URL_${service.toUpperCase()}`];
  if (override !== undefined && override !== '') return override;

  const base = requireEnv('DATABASE_URL');
  const url = withLocalHost(new URL(base));

  // Assigned rather than concatenated: a password containing `@` or `/` would tear the string
  // apart, and `URL` is what knows how to escape each part.
  url.username = serviceDatabaseRole(service);
  url.password = requireEnv(`DB_PASSWORD_${service.toUpperCase()}`);
  url.pathname = `/${serviceDatabaseName(service)}`;
  return url.toString();
}

/**
 * The role a module connects as. Derived from the slug, exactly like the database name and for the
 * same reason: taken from the connection string instead, `db-init`, the application and
 * `bootstrap:worktree` would drift apart with nothing to notice it.
 */
export function serviceDatabaseRole(service: string): string {
  return truncateIdentifier(`${projectSlug()}_${service}`);
}

/**
 * The connection string of the role that owns the server — `CREATE ROLE`, `ALTER DATABASE`,
 * `GRANT`. Only `db-init` has any business with it.
 */
export function adminDatabaseUrl(): string {
  return withLocalHost(new URL(requireEnv('DATABASE_URL'))).toString();
}

/**
 * PostgreSQL truncates every identifier to 63 bytes, silently and everywhere. Applying it where the
 * name is derived keeps it from happening later in five places at once — but it does not make long
 * slugs safe, and `db-init` refuses two names that survive truncation identically.
 */
export const IDENTIFIER_LIMIT = 63;

export function truncateIdentifier(name: string): string {
  return Buffer.from(name, 'utf8').subarray(0, IDENTIFIER_LIMIT).toString();
}

export function serviceDatabaseName(service: string): string {
  return truncateIdentifier(`${projectSlug()}_${service}`);
}

/** Name of the session cookie. Scoped by project slug so parallel worktrees do not collide. */
export function sessionCookieName(): string {
  return `${projectSlug()}_session`;
}

/**
 * Name of the CSRF cookie of one admin surface. The panel and each embedded service admin issue
 * their own, because they share an origin: one name for all of them means whichever asked last
 * overwrites the others' cookie, and the first is refused on its next change with nothing to say why.
 */
export function csrfCookieName(scope: string): string {
  return `${projectSlug()}_csrf_${scope}`;
}
