import { pathToFileURL } from 'node:url';

import { createDatabaseInterface } from '@grimcode/pg-interface';
import { serve } from '@hono/node-server';
import { createModule as createAdminModule, type AdminEnv } from '@template/admin';
import { createApp as createAppApp } from '@template/app';
import { createModule as createAuthModule, type AuthEnv } from '@template/auth';
import {
  createModule as createEmailModule,
  type EmailEnv,
  type MailSettings,
} from '@template/email';
import { createApp as createGatewayApp, type GatewayTargets } from '@template/gateway';
import {
  createModule as createNotificationsModule,
  type NotificationsEnv,
} from '@template/notifications';
import {
  createLogger,
  intEnv,
  optionalEnv,
  projectSlug,
  publicSiteUrl,
  requireEnv,
  type FetchLike,
  type Logger,
  type ServiceApp,
} from '@template/shared';
import { createApp as createSiteApp } from '@template/site/server';
import { createApp as createUsersApp, type UsersEnv } from '@template/users';

/**
 * Modules with a database of their own: each creates and migrates it, so this list only decides who
 * is told a connection string.
 */
export const DATABASE_MODULES = ['admin', 'auth', 'email', 'notifications', 'users'] as const;

export type DatabaseModule = (typeof DATABASE_MODULES)[number];

/** Every module that answers requests, by the name Gateway routes under. */
export type ModuleName = DatabaseModule | 'app' | 'gateway';

/**
 * A module's application with its `Bindings` type forgotten: each declares its own, so a uniform
 * map can promise only `fetch`.
 */
export type MountedApp = Pick<ServiceApp, 'fetch'>;

export interface Composition {
  logger: Logger;
  apps: Record<ModuleName, MountedApp>;
}

/**
 * Builds the whole program: read the environment, hand each module its own, wire them together.
 * The only place allowed to know every module, and the only thing it knows is the order of calls.
 */
export async function compose(): Promise<Composition> {
  // Each module builds its own logger; this one is the program's.
  const logger = createLogger('server');

  const mail = mailSettings();
  const auth = authSettings();

  assertDistinctDatabases();

  /*
   * Named one by one rather than only as a map: a caller into a neighbour is handed the same
   * environment a request would carry, and `Record<ModuleName, object>` would hand it `object`.
   */
  const adminEnv: AdminEnv = databaseEnv('admin');
  const authEnv: AuthEnv = { ...auth, ...databaseEnv('auth') };
  const emailEnv: EmailEnv = { ...databaseEnv('email'), mail };
  const notificationsEnv: NotificationsEnv = databaseEnv('notifications');
  const usersEnv: UsersEnv = databaseEnv('users');

  // `{}` means the module needs nothing per request — not that it reads the process itself.
  const envByModule: Record<ModuleName, object> = {
    admin: adminEnv,
    app: {},
    auth: authEnv,
    email: emailEnv,
    gateway: {},
    notifications: notificationsEnv,
    users: usersEnv,
  };

  /*
   * A call to a neighbour, and the one place a module's environment is supplied. The application is
   * looked up when the request arrives, not when this closure is made, so a module can be handed a
   * way to reach one that does not exist yet.
   */
  const call =
    (name: ModuleName): FetchLike =>
    (request) =>
      apps[name].fetch(request, envByModule[name]);

  const site = createSiteApp({ origin: publicSiteUrl() });

  /*
   * The panel's database section. Not a module: it looks at every module's database at once, which is
   * why only the owner reaches it and why no grant can name it. It opens its own small pools rather
   * than borrowing the modules' — a heavy query typed into the console would otherwise hold
   * connections the site needs.
   *
   * The path is Gateway's to route; it is repeated here because the interface has to know where it is
   * mounted to tell its own paths from the rest of the URL.
   */
  const databaseInterface = createDatabaseInterface({
    basePath: '/admin/embed/database',
    databases: DATABASE_MODULES.map((module) => ({
      name: serviceDatabaseName(module),
      connectionString: serviceDatabaseUrl(module),
    })),
    log: (event) => {
      const write = event.level === 'error' ? logger.error : logger.info;
      write.call(logger, event.message, {
        module: 'pg-interface',
        ...(event.database === undefined ? {} : { database: event.database }),
        ...(event.error === undefined ? {} : { error: event.error }),
      });
    },
  });

  const targets: GatewayTargets = {
    site: (request) => site.fetch(request),
    database: (request) => databaseInterface.fetch(request),
    app: call('app'),
    admin: call('admin'),
    auth: call('auth'),
    users: call('users'),
    notifications: call('notifications'),
    email: call('email'),
  };

  /*
   * A module with an internal surface is built once and reached two ways: by request, for what
   * Gateway routes to it, and by a caller, which is how a neighbour invokes its procedures. The
   * environment is supplied here in both cases — a direct call has no request to carry it.
   */
  const email = createEmailModule();
  const notifications = createNotificationsModule({
    callEmail: (called) => email.internalCaller(emailEnv, called),
  });
  const authModule = createAuthModule({
    callNotifications: (called) => notifications.internalCaller(notificationsEnv, called),
  });
  const admin = createAdminModule({
    callAuth: (called) => authModule.internalCaller(authEnv, called),
  });

  const apps: Record<ModuleName, MountedApp> = {
    email: email.app,
    notifications: notifications.app,
    auth: authModule.app,
    admin: admin.app,
    users: createUsersApp({ callAuth: (called) => authModule.internalCaller(authEnv, called) }),
    app: createAppApp(),
    gateway: createGatewayApp({
      targets,
      callAdmin: (called) => admin.internalCaller(adminEnv, called),
    }),
  };

  return { logger, apps };
}

/**
 * Refuses a `PROJECT_SLUG` under which two modules would share one database — PostgreSQL truncates
 * identifiers silently. Before the modules are built, so it stops the program instead of surfacing
 * later as shared tables.
 */
function assertDistinctDatabases(): void {
  const seen = new Map<string, DatabaseModule>();

  for (const module of DATABASE_MODULES) {
    const database = serviceDatabaseName(module);
    const clash = seen.get(database);
    if (clash !== undefined) {
      throw new Error(
        `PROJECT_SLUG is too long: the databases of "${clash}" and "${module}" are both ` +
          `"${database}" once PostgreSQL cuts them to ${IDENTIFIER_LIMIT} bytes; shorten it, or ` +
          'two modules sharing one database would share their data.',
      );
    }
    seen.set(database, module);
  }
}

/**
 * The composer's side of what each module declares in its own `env.ts`. No shared type on purpose:
 * one in `shared` would make five modules agree with each other.
 */
export interface ModuleDatabase {
  databaseUrl: string;
  databaseName: string;
  maintenanceUrl: string;
}

/** A module gets strings, never variable names. */
export function databaseEnv(module: DatabaseModule): ModuleDatabase {
  return {
    databaseUrl: serviceDatabaseUrl(module),
    databaseName: serviceDatabaseName(module),
    maintenanceUrl: maintenanceDatabaseUrl(),
  };
}

/**
 * Auth's settings; the default is a decision about this installation. Kept apart from `databaseEnv`
 * so it stays callable without a database, which is what lets `index.test.ts` pin that default.
 */
export function authSettings(): Omit<AuthEnv, keyof ModuleDatabase> {
  return {
    sessionTtlSeconds: intEnv('AUTH_SESSION_TTL_SECONDS', 60 * 60 * 24 * 30),
  };
}

/**
 * Forwarded as written: what empty means belongs to the module. Decided here, `EMAIL_PROVIDER`
 * misspelt would be this file choosing not to mail people.
 */
export function mailSettings(): MailSettings {
  return {
    provider: optionalEnv('EMAIL_PROVIDER', ''),
    apiKey: optionalEnv('UNISENDER_GO_API_KEY', ''),
    apiUrl: optionalEnv('UNISENDER_GO_API_URL', ''),
    fromAddress: optionalEnv('EMAIL_FROM_ADDRESS', ''),
    fromName: optionalEnv('EMAIL_FROM_NAME', ''),
  };
}

/**
 * One module's database: `DATABASE_URL` with the name swapped for `<PROJECT_SLUG>_<module>`. One
 * credential, not five — creating a database needs an account allowed to, and such an account opens
 * all of them.
 */
export function serviceDatabaseUrl(module: string): string {
  const override = optionalEnv(`DATABASE_URL_${module.toUpperCase()}`, '');
  if (override !== '') return override;

  const url = new URL(requireEnv('DATABASE_URL'));
  url.pathname = `/${serviceDatabaseName(module)}`;
  return url.toString();
}

/** The server itself: a database cannot be created from inside itself. */
export function maintenanceDatabaseUrl(): string {
  return new URL(requireEnv('DATABASE_URL')).toString();
}

/** PostgreSQL cuts every identifier to this many bytes, silently. */
export const IDENTIFIER_LIMIT = 63;

export function serviceDatabaseName(module: string): string {
  return Buffer.from(`${projectSlug()}_${module}`, 'utf8')
    .subarray(0, IDENTIFIER_LIMIT)
    .toString();
}

/** Where the program listens when nothing says otherwise. */
const DEFAULT_PORT = 8080;

/**
 * Port to listen on. `PORT` first, because that is what a hosting platform sets; then
 * `GATEWAY_PORT` from `.env`, which is what lets two worktrees run at once on one machine.
 */
function ownPort(): number {
  for (const name of ['PORT', 'GATEWAY_PORT']) {
    const port = intEnv(name, 0);
    if (port !== 0) return port;
  }
  return DEFAULT_PORT;
}

/**
 * The program, when this file is the program. Guarded because the same file is imported — by its
 * own tests and by the acceptance suite, which needs the database names — and an entry that opened
 * a port on import would open one there too.
 *
 * Opening the port lives here rather than in `shared` because there is one listener: the door out of
 * the process belongs to the program, and a module that could import it could open one of its own.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { apps, logger } = await compose();
  const port = ownPort();

  serve({ fetch: apps.gateway.fetch, port, hostname: '0.0.0.0' }, (info) => {
    // `listener`, not `service`: the payload would overwrite the logger's own field, which says which
    // process wrote the line.
    logger.info('service listening', { listener: 'gateway', port: info.port });
  });
}
