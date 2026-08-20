/**
 * The boundary rules of the repository, written out in one place. Two checks read them and they are
 * the same rule seen from two sides: `check-boundaries.mjs` — what a file may import;
 * `check-dependencies.mjs` — what a manifest may declare. A rule that exists on only one of the two
 * sides is a rule with a door next to it. Neither is the first line of defence — pnpm, `rootDir` and
 * `references` are; these catch what those miss.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Which workspace packages each area may reach for.
 *
 * A `*` in an area makes every directory under it a compartment of its own, so a relative import
 * from `modules/admin` into `modules/auth` is a violation even though both match the same rule.
 *
 * `composition` holds the widest permission in the repository, affordable only while it contains
 * nothing but the order of calls: the day it decides something, this line is the hole it decides
 * through.
 */
export const EVERY_PACKAGE = '*';

export const AREA_RULES = [
  { area: 'composition', mayUse: EVERY_PACKAGE },
  { area: 'shared', mayUse: [] },
  { area: 'modules/*', mayUse: ['@template/shared'], neighbourSubpath: true },
  /*
   * The suite imports no module. It reaches for `shared`, and for the composer in one place: asking
   * PostgreSQL which databases exist needs the names, and deriving them is the composer's. Allowed
   * because the composer is not a module — importing it borrows a name, not somebody's data.
   */
  { area: 'tests', mayUse: ['@template/shared', '@template/composition'] },
  { area: 'scripts', mayUse: [] },
  { area: '.', mayUse: [] },
];

/**
 * The one subpath a module may reach for in a neighbour: a tRPC client is typed from the server's
 * router, so six modules of seven have to see a type that lives in another.
 */
export const NEIGHBOUR_SUBPATH = 'contract';

/** Whether a rule allows reaching for a workspace package, by the specifier as written. */
export function allows(rule, packageName, specifier = packageName) {
  if (rule.mayUse === EVERY_PACKAGE || rule.mayUse.includes(packageName)) return true;
  return rule.neighbourSubpath === true && specifier === `${packageName}/${NEIGHBOUR_SUBPATH}`;
}

/** How to name a rule's allowance when reporting a violation. */
export function describeAllowance(rule) {
  if (rule.mayUse === EVERY_PACKAGE) return 'every workspace package';
  const named = rule.mayUse.length > 0 ? rule.mayUse.join(', ') : 'no workspace package';
  return rule.neighbourSubpath === true
    ? `${named}, and a neighbour only as @template/<name>/${NEIGHBOUR_SUBPATH}`
    : named;
}

/**
 * Packages that open a door out of the process. Written out one by one because this is not a class a
 * check can recognise, and a mail client added tomorrow would have to be added by hand. `@types/pg` is
 * absent: types are erased at build time and open nothing.
 */
export const OUTSIDE_PROCESS_PACKAGES = ['pg'];

/**
 * Who may declare one, as repository-relative directories.
 *
 * It used to be `shared` alone, and the rule said what it meant: nothing but `shared` talks to a
 * database, and a module is handed a pool. A module now opens its own — it decides how many
 * connections it wants and when — so the driver is its dependency too, and the list grew from one to
 * six.
 *
 * What that costs is worth stating: the check no longer says "only one package talks to the database",
 * it says "only a package that owns a database, or checks one, does". `app`, `site` and `gateway` are
 * still refused, and a new module that needs the driver has to be added here — which is the moment to
 * ask whether it really owns a database of its own. `tests` is here for the one acceptance check that
 * asks PostgreSQL directly which databases exist.
 */
export const OUTSIDE_PROCESS_HOMES = [
  'shared',
  'tests',
  'modules/admin',
  'modules/auth',
  'modules/email',
  'modules/notifications',
  'modules/users',
];

/**
 * The compartment a repository-relative path belongs to, with the rule that governs it. `dir` is
 * what tells two modules apart under the same `modules/*` rule.
 */
export function compartmentOf(relative) {
  const segments = relative.split('/');

  for (const rule of AREA_RULES) {
    if (rule.area === '.') continue;
    const areaSegments = rule.area.split('/');
    const matches = areaSegments.every((segment, index) =>
      segment === '*' ? segments[index] !== undefined : segment === segments[index],
    );
    if (matches) {
      return { rule, dir: segments.slice(0, areaSegments.length).join('/') };
    }
  }

  return { rule: AREA_RULES.find((rule) => rule.area === '.'), dir: '.' };
}

/** Expands the `packages:` globs of `pnpm-workspace.yaml`; only a trailing `*` is supported. */
function workspaceGlobs() {
  const source = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const packages = /packages:\s*\n((?:\s*-\s*\S+\n?)+)/.exec(source);
  if (!packages) throw new Error('Could not find the packages list in pnpm-workspace.yaml');
  return [...packages[1].matchAll(/-\s*'?"?([^'"\s]+)'?"?/g)].map((entry) => entry[1]);
}

/**
 * Every workspace package, read from `pnpm-workspace.yaml` rather than hardcoded, so renaming
 * `modules/` is one edit in the manifest and not a second one here.
 */
export function workspacePackages() {
  const found = [];

  for (const glob of workspaceGlobs()) {
    const dirs = glob.endsWith('/*')
      ? readdirSync(join(repoRoot, glob.slice(0, -2)), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${glob.slice(0, -2)}/${entry.name}`)
      : [glob];

    for (const dir of dirs) {
      const manifestPath = join(repoRoot, dir, 'package.json');
      if (!statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      found.push({ name: manifest.name, dir, manifest });
    }
  }

  return found;
}
