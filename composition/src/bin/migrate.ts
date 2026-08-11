import { createLogger, createPool, runMigrations, waitForDatabase } from '@template/shared';
import { seedTemplates } from '@template/email';

import { DATABASE_MODULES, MIGRATIONS, type DatabaseModule } from '../wiring.js';

/**
 * Applies the migrations. Without an argument, all of them; with one, that module alone.
 *
 * Run on import, a failed migration put the container into a restart loop instead of failing the
 * deploy. As a command it fails once, with the name of the module that stopped it, before the
 * application answers a request. The argument is for a person at a terminal.
 */
const logger = createLogger('migrate');

const requested = process.argv[2];

if (requested !== undefined && !DATABASE_MODULES.includes(requested as DatabaseModule)) {
  logger.error('unknown module', { requested, known: DATABASE_MODULES });
  process.exit(1);
}

const modules = requested === undefined ? DATABASE_MODULES : [requested as DatabaseModule];

for (const module of modules) {
  const pool = createPool(module);
  const moduleLogger = logger.child({ module });

  try {
    await waitForDatabase(pool);
    await runMigrations(pool, MIGRATIONS[module], moduleLogger);

    /*
     * Seeding belongs to the same step and not to the application's start-up: it needs the schema
     * just applied, it is idempotent, and it renders every seeded template through
     * `@maily-to/render` — CPU-bound work the process used to do on every restart.
     */
    if (module === 'email') await seedTemplates({ pool, logger: moduleLogger });
  } catch (error) {
    moduleLogger.error('migration failed', { error });
    await pool.end().catch(() => undefined);
    process.exit(1);
  }

  await pool.end();
}

logger.info('migrations complete', { modules });
