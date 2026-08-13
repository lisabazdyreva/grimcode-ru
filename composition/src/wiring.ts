import { createApp as createAdminApp, migrations as adminMigrations } from '@template/admin';
import type { AdminInternalRouter } from '@template/admin/contract';
import { createApp as createAppApp } from '@template/app';
import {
  createApp as createAuthApp,
  migrations as authMigrations,
  type IsActiveOwner,
} from '@template/auth';
import {
  createApp as createEmailApp,
  migrations as emailMigrations,
  type MailSettings,
} from '@template/email';
import { createApp as createGatewayApp, type GatewayTargets } from '@template/gateway';
import {
  createApp as createNotificationsApp,
  migrations as notificationsMigrations,
} from '@template/notifications';
import {
  createLogger,
  createPool,
  createTrpcClient,
  internalServiceUrl,
  optionalEnv,
  publicSiteUrl,
  serviceDatabaseName,
  waitForDatabase,
  type FetchLike,
  type Logger,
  type Pool,
  type ServiceApp,
} from '@template/shared';
import { createApp as createSiteApp } from '@template/site/server';
import { createApp as createUsersApp, migrations as usersMigrations } from '@template/users';

/**
 * The modules with a database of their own. One list read by three things — this file, `bin/migrate`
 * and `bin/db-init` — so a module added here and nowhere else gets a pool, migrations and a role.
 */
export const MIGRATIONS = {
  admin: adminMigrations,
  auth: authMigrations,
  email: emailMigrations,
  notifications: notificationsMigrations,
  users: usersMigrations,
} as const;

export type DatabaseModule = keyof typeof MIGRATIONS;

export const DATABASE_MODULES = Object.keys(MIGRATIONS) as DatabaseModule[];

/** Every module that answers requests, by the name Gateway routes under. */
export type ModuleName = DatabaseModule | 'app' | 'gateway';

export interface Composition {
  logger: Logger;
  pools: Record<DatabaseModule, Pool>;
  apps: Record<ModuleName, ServiceApp>;
  /**
   * The site, kept beside the rest rather than among them: the one module not built on
   * `createServiceApp` — it wraps the framework's own handler — so it does not fit the shared map.
   */
  site: ReturnType<typeof createSiteApp>;
  /** Closes every pool. The listener, if there is one, is not this function's business. */
  close(): Promise<void>;
}

/**
 * Builds the whole program: pools, then modules, then the wiring between them.
 *
 * The only place that knows every module, and the only thing it may know is the order of calls: the
 * moment a decision appears here, the reason for a separate package with the widest permission in
 * the repository is gone.
 */
export async function compose(): Promise<Composition> {
  const logger = createLogger('server');

  const pools = Object.fromEntries(
    DATABASE_MODULES.map((name) => [name, createPool(name)]),
  ) as Record<DatabaseModule, Pool>;

  /*
   * The pools above and this line are everything that reads the environment, and `forgetSecrets`
   * runs below every module. Between those two points no module has to be built in any particular
   * order for the credentials it was handed to still be there.
   */
  const mail = mailSettings();

  // Cold local starts race the PostgreSQL container; five waits at once cost the same as one.
  await Promise.all(DATABASE_MODULES.map((name) => waitForDatabase(pools[name])));

  /*
   * Then assert, per module, that the pool opened the database it was supposed to: a role cannot open
   * the wrong one, but a `DATABASE_URL_<MODULE>` override bypasses the role — and an override is what
   * a deployment edits by hand. The first sign of it would be data in the wrong place.
   */
  await Promise.all(
    DATABASE_MODULES.map(async (name) => {
      const { rows } = await pools[name].query<{ current_database: string }>(
        'SELECT current_database()',
      );
      const opened = rows[0]?.current_database;
      const expected = serviceDatabaseName(name);
      if (opened !== expected) {
        throw new Error(`Module "${name}" opened database "${opened}", expected "${expected}"`);
      }
    }),
  );

  /*
   * The applications, and the calls between them.
   *
   * `call` exists because the wiring has a genuine cycle in it: Admin asks Auth who the session
   * belongs to, and Auth asks Admin whether an identity is an active owner.
   *
   * Every one of these goes through the contract, exactly as over the network: a direct method call
   * would hide what only shows up at a boundary — Zod coercing an input, a `Date` becoming a string.
   */
  const apps = {} as Record<ModuleName, ServiceApp>;
  const call =
    (name: ModuleName): FetchLike =>
    (request) =>
      apps[name].fetch(request);

  const moduleLogger = (name: ModuleName) => logger.child({ module: name });

  const isActiveOwner: IsActiveOwner = async (userId) => {
    const admin = createTrpcClient<AdminInternalRouter>({
      url: `${internalServiceUrl('admin')}/internal/rpc`,
      fetch: call('admin'),
    });
    return (await admin.isActiveOwner.query({ userId })).activeOwner;
  };

  apps.email = createEmailApp({ logger: moduleLogger('email'), pool: pools.email, mail });

  apps.notifications = createNotificationsApp({
    logger: moduleLogger('notifications'),
    pool: pools.notifications,
    callEmail: call('email'),
  });

  apps.auth = createAuthApp({
    logger: moduleLogger('auth'),
    pool: pools.auth,
    callNotifications: call('notifications'),
    isActiveOwner,
  });

  apps.admin = createAdminApp({
    logger: moduleLogger('admin'),
    pool: pools.admin,
    callAuth: call('auth'),
  });

  apps.users = createUsersApp({
    logger: moduleLogger('users'),
    pool: pools.users,
    callAuth: call('auth'),
  });

  apps.app = createAppApp({ logger: moduleLogger('app') });

  const site = createSiteApp({ origin: publicSiteUrl() });

  const targets: GatewayTargets = {
    site: (request) => site.fetch(request),
    app: call('app'),
    admin: call('admin'),
    auth: call('auth'),
    users: call('users'),
    notifications: call('notifications'),
    email: call('email'),
  };

  apps.gateway = createGatewayApp({ logger: moduleLogger('gateway'), targets });

  forgetSecrets(logger);

  return {
    logger,
    pools,
    apps,
    site,
    close: async () => {
      await Promise.all(Object.values(pools).map((pool) => pool.end()));
    },
  };
}

/**
 * The mail settings of the Email module, read here because a module does not read the environment.
 *
 * Every one of them is read the same way and forwarded as written — unset reads as empty, and not
 * one of these lines says what empty then means. That belongs to the module: an empty provider is
 * the log transport, an empty address is a provider that refuses to send. Written here instead,
 * `EMAIL_PROVIDER` misspelt in a `.env` would be this file's decision about whether to mail people.
 */
function mailSettings(): MailSettings {
  return {
    provider: optionalEnv('EMAIL_PROVIDER', ''),
    apiKey: optionalEnv('UNISENDER_GO_API_KEY', ''),
    apiUrl: optionalEnv('UNISENDER_GO_API_URL', ''),
    fromAddress: optionalEnv('EMAIL_FROM_ADDRESS', ''),
    fromName: optionalEnv('EMAIL_FROM_NAME', ''),
  };
}

/**
 * Removes from the environment everything that belonged to one module, once it has been handed out.
 *
 * The second line behind "a module does not read the environment", now that one process shares one
 * `process.env`.
 *
 * **The order still matters, but it is one rule in one file:** everything that reads the environment
 * happens at the top of `compose()` — the pools and the mail settings — and this runs at the bottom.
 * Reading a secret anywhere between the two is what would break, and the failure is quiet enough to
 * be worth the rule: an emptied key leaves UniSender Go refusing every message, and the refusal
 * surfaces as a delivery recorded `failed` rather than as anything at start-up.
 */
function forgetSecrets(logger: Logger): void {
  const forgotten = Object.keys(process.env).filter(
    (name) =>
      name === 'DATABASE_URL' ||
      name.startsWith('DATABASE_URL_') ||
      name.startsWith('DB_PASSWORD_') ||
      name === 'UNISENDER_GO_API_KEY',
  );

  for (const name of forgotten) delete process.env[name];

  // The names, never the values: this line exists so that a missing one is findable later.
  logger.info('secrets removed from the environment', { forgotten });
}
