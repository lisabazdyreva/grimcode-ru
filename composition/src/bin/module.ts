import { serveService, type InternalServiceName } from '@template/shared';

import { compose, type ModuleName } from '../wiring.js';

/**
 * Runs a single module on its own port: `node dist/bin/module.js auth`.
 *
 * This lives in the composer rather than inside the module's own package, and that is the point of
 * it: a bin inside a module would have to read the environment and open a pool — the two things a
 * module is forbidden to do — so it would need an exception carved out of both rules in the very
 * file that breaks them. Here the permission already exists and the same wiring runs.
 *
 * Nothing checks that this still works at runtime — no test, no `pnpm check` — so treat what it
 * proves accordingly. What it does keep honest is the shape: it is compiled with everything else, so
 * a change to the wiring that leaves it behind fails the build rather than rotting quietly.
 */
const requested = process.argv[2];

const { apps, logger } = await compose();

if (requested === undefined || !Object.hasOwn(apps, requested)) {
  logger.error('unknown module', { requested, known: Object.keys(apps) });
  process.exit(1);
}

const name = requested as ModuleName;

serveService(apps[name], name as InternalServiceName, logger.child({ module: name }));
