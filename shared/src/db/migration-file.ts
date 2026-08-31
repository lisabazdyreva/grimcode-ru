/**
 * Writing a migration into the project, rather than only into a database.
 *
 * The database section can add a column, and a column that lives only in the database it was added to
 * is a column nobody else ever gets: a colleague pulls the code and builds their database from the
 * migrations in it. So the change is written here as one more migration file, and from then on it
 * travels the way every other statement in this project travels — by git, applied by `runMigrations`.
 *
 * This file knows what a migration file looks like; it does not decide when one is written. That is
 * the entry's business, and it hands a folder in.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A migration as it is about to be written: what it does, and what it will be called. */
export interface MigrationText {
  version: number;
  name: string;
  sql: string;
}

const INDEX = 'index.ts';

/** A file name carries the version and the name, so the two can never drift apart unnoticed. */
export function migrationFileName(version: number, name: string): string {
  return `${String(version).padStart(3, '0')}-${name}.ts`;
}

/**
 * Whether this folder is one migrations can be written into.
 *
 * The answer is what decides, at startup, whether the database section offers to change a table's
 * shape at all: a built copy of the program has no `src/` beside it, so there is nowhere to write and
 * nothing to commit. Better that the screen shows no button than that a button explains itself.
 */
export function canWriteMigrations(folder: string): boolean {
  return existsSync(join(folder, INDEX));
}

/**
 * The highest version this folder holds, or zero when it holds none.
 *
 * Read from the folder rather than from the compiled list, because the compiled list is one build
 * behind — two columns added between two builds would otherwise both be version 2. It is only half
 * the answer, though: whoever writes the next migration has to take the database into account too,
 * which may have been carried further than these files were.
 */
export function highestMigrationVersion(folder: string): number {
  const versions = readdirSync(folder)
    .filter((file) => file.endsWith('.ts') && file !== INDEX)
    .map((file) => Number.parseInt(file.slice(0, 3), 10))
    .filter((version) => Number.isInteger(version));

  return Math.max(0, ...versions);
}

/**
 * Writes the migration and adds it to the folder's list.
 *
 * The file first, the list second: an unlisted file is refused by `check-migrations` and is one line
 * away from being right, whereas a list naming a file that does not exist stops the build.
 */
export function writeMigration(folder: string, migration: MigrationText): void {
  const file = migrationFileName(migration.version, migration.name);
  const alias = `version${migration.version}`;

  writeFileSync(join(folder, file), migrationSource(migration), 'utf8');

  const indexPath = join(folder, INDEX);
  const index = readFileSync(indexPath, 'utf8');

  const imports = [...index.matchAll(/^import \{ migration as \w+ \} from '\.\/[^']+\.js';$/gm)];
  const last = imports.at(-1);
  if (!last || last.index === undefined) {
    throw new Error(`${indexPath} imports no migration this writer can add one after.`);
  }

  const line = `import { migration as ${alias} } from './${file.replace(/\.ts$/, '.js')}';`;
  const withImport =
    index.slice(0, last.index + last[0].length) + `\n${line}` + index.slice(last.index + last[0].length);

  const listed = /(migrations: readonly Migration\[\] = \[)([^\]]*)(\])/.exec(withImport);
  if (!listed?.[1] || listed[2] === undefined || !listed[3]) {
    throw new Error(`${indexPath} has no migrations array this writer can add to.`);
  }

  const entries = listed[2]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  entries.push(alias);

  writeFileSync(
    indexPath,
    withImport.replace(listed[0], `${listed[1]}${entries.join(', ')}${listed[3]}`),
    'utf8',
  );
}

/**
 * The text of a written migration.
 *
 * The statement keeps the indentation it is given, and the comment above it says why: `runMigrations`
 * remembers a version by the checksum of this text, so tidying the file up is what makes a module
 * refuse to start against a database that has already run it.
 */
function migrationSource(migration: MigrationText): string {
  return `import type { Migration } from '@template/shared';

/**
 * Written by the database section of the admin panel, not by hand.
 *
 * Leave the statement exactly as it is, indentation included: the version is remembered by the
 * checksum of this text, and reindenting it stops this module against every database that has already
 * run it. To undo what it did, add another migration.
 */
export const migration: Migration = {
  version: ${migration.version},
  name: '${migration.name}',
  sql: \`
${migration.sql}
  \`,
};
`;
}
