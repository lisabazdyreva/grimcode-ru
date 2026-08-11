import type { adminInternalContract, ContractRouterClient } from '@template/contracts';

import { createApp as createAdminApp, migrations as adminMigrations } from '@template/admin';
import { createApp as createAppApp } from '@template/app';
import {
  createApp as createAuthApp,
  migrations as authMigrations,
  type IsActiveOwner,
} from '@template/auth';
import {
  createApp as createEmailApp,
  migrations as emailMigrations,
  seedTemplates,
} from '@template/email';
import { createApp as createGatewayApp, type GatewayTargets } from '@template/gateway';
import {
  createApp as createNotificationsApp,
  migrations as notificationsMigrations,
} from '@template/notifications';
import {
  createLogger,
  createPool,
  createRpcClient,
  internalServiceUrl,
  publicSiteUrl,
  runMigrations,
  waitForDatabase,
  type FetchLike,
  type Logger,
  type Pool,
  type ServiceApp,
} from '@template/shared';
import { createApp as createSiteApp } from '@template/site/server';
import { createApp as createUsersApp, migrations as usersMigrations } from '@template/users';

/**
 * The modules with a database of their own, each with the migrations it owns.
 *
 * Order matters only in that a failure names the module it happened in, and that the same list is
 * what opens the pools, so a module can never be migrated without being given one.
 */
const DATABASES = {
  admin: adminMigrations,
  auth: authMigrations,
  email: emailMigrations,
  notifications: notificationsMigrations,
  users: usersMigrations,
} as const;

export type DatabaseModule = keyof typeof DATABASES;

/** Every module that answers requests, by the name Gateway routes under. */
export type ModuleName = DatabaseModule | 'app' | 'gateway';

export interface Composition {
  logger: Logger;
  pools: Record<DatabaseModule, Pool>;
  apps: Record<ModuleName, ServiceApp>;
  /**
   * The site, kept beside the rest rather than among them.
   *
   * It is the one module that is not built on `createServiceApp` — it wraps the framework's own
   * handler — so it is a plain Hono application and does not fit the map the others share.
   */
  site: ReturnType<typeof createSiteApp>;
  /** Closes every pool. The listener, if there is one, is not this function's business. */
  close(): Promise<void>;
}

/**
 * Builds the whole program: pools, then databases, then modules, then the wiring between them.
 *
 * This is the only place that knows every module, and the only thing it is allowed to know is the
 * order of calls. There is not one decision in here — no routing, no policy, no defaulting — and
 * the moment one appears, the reason for a separate package with the widest permission in the
 * repository is gone.
 */
export async function compose(): Promise<Composition> {
  const logger = createLogger('server');

  const pools = Object.fromEntries(
    (Object.keys(DATABASES) as DatabaseModule[]).map((name) => [name, createPool(name)]),
  ) as Record<DatabaseModule, Pool>;

  // Cold local starts race the PostgreSQL container; five waits at once cost the same as one.
  await Promise.all(Object.values(pools).map((pool) => waitForDatabase(pool)));

  for (const [name, migrations] of Object.entries(DATABASES) as [
    DatabaseModule,
    typeof adminMigrations,
  ][]) {
    await runMigrations(pools[name], migrations, logger.child({ module: name }));
  }

  await seedTemplates({ pool: pools.email, logger: logger.child({ module: 'email' }) });

  /*
   * The applications, and the calls between them.
   *
   * `call` is the one piece of indirection here, and it exists because the wiring has a genuine
   * cycle in it: Admin asks Auth who the session belongs to, and Auth asks Admin whether an
   * identity is an active owner. Resolving the neighbour at call time instead of at build time is
   * what lets both be built at all.
   *
   * Every one of these goes through the contract, exactly as it did over the network. A direct
   * method call would be faster and would hide the two things that only show up at a boundary —
   * Zod coercing an input, a `Date` becoming a string through JSON — until the day a module has to
   * move back out into a service of its own.
   */
  const apps = {} as Record<ModuleName, ServiceApp>;
  const call =
    (name: ModuleName): FetchLike =>
    (request) =>
      apps[name].fetch(request);

  const moduleLogger = (name: ModuleName) => logger.child({ module: name });

  const isActiveOwner: IsActiveOwner = async (userId) => {
    const admin = createRpcClient<ContractRouterClient<typeof adminInternalContract>>({
      url: `${internalServiceUrl('admin')}/internal/rpc`,
      fetch: call('admin'),
    });
    return (await admin.isActiveOwner({ userId })).activeOwner;
  };

  apps.email = createEmailApp({ logger: moduleLogger('email'), pool: pools.email });

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
