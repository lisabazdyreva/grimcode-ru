/**
 * The boundary rules of the repository, written out in one place.
 *
 * Two checks read this file and they are the same rule seen from two sides:
 *
 * - `check-boundaries.mjs` — what a file may import;
 * - `check-dependencies.mjs` — what a manifest may declare.
 *
 * A module that may not import `@template/auth` may not declare it either, and a rule that only
 * exists on one of the two sides is a rule with a door next to it. One table means both sides move
 * together when the table changes.
 *
 * Neither of these is the first line of defence. pnpm refuses to resolve a package a manifest does
 * not declare, `rootDir` refuses a relative import that leaves the package, and `references` in the
 * tsconfigs keep the compile graph narrow. These checks are what catches the cases those three miss:
 * a manifest that declares something it should not, and a third-party package that opens a door out
 * of the process.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Which workspace packages each area may reach for.
 *
 * The area is a path from the repository root; a `*` stands for one directory and makes every
 * directory under it a compartment of its own — `modules/admin` and `modules/auth` do not share
 * anything, and a relative import from one into the other is a violation even though both match the
 * same rule. `.` is the fallback for everything that is not listed: loose files at the root.
 *
 * `mayUse` names workspace packages only. Third-party packages are not the subject of this table —
 * see `OUTSIDE_PROCESS_PACKAGES` for the one thing that is.
 *
 * `composition` is the single exception and holds the widest permission in the repository, because
 * its whole job is to know every module and wire them together. That is affordable only while it
 * contains nothing but the order of calls: the day it starts deciding something, this line is the
 * hole it decides through.
 */
export const EVERY_PACKAGE = '*';

export const AREA_RULES = [
  { area: 'composition', mayUse: EVERY_PACKAGE },
  { area: 'contracts', mayUse: [] },
  { area: 'shared', mayUse: ['@template/contracts'] },
  { area: 'modules/*', mayUse: ['@template/contracts', '@template/shared'] },
  { area: 'tests', mayUse: [] },
  { area: 'scripts', mayUse: [] },
  { area: '.', mayUse: [] },
];

/** Whether a rule allows reaching for a workspace package. */
export function allows(rule, packageName) {
  return rule.mayUse === EVERY_PACKAGE || rule.mayUse.includes(packageName);
}

/** How to name a rule's allowance when reporting a violation. */
export function describeAllowance(rule) {
  if (rule.mayUse === EVERY_PACKAGE) return 'every workspace package';
  return rule.mayUse.length > 0 ? rule.mayUse.join(', ') : 'no workspace package';
}

/**
 * Packages that open a door out of the process. Only `shared` may declare one.
 *
 * The list has exactly one entry today, and it is written out one by one on purpose: this is not a
 * class a check can recognise. Reading it as "third-party runtime packages" would be wrong in both
 * directions — `@orpc/*`, `hono`, `react` and `zod` stay inside the process and are not on it, and
 * a mail client added tomorrow would have to be added here by hand. There is no mail client in the
 * repository today: `modules/email` talks to Unisender with a plain `fetch`.
 *
 * `@types/pg` is deliberately absent. Types are erased at build time and open nothing; five modules
 * declare it because `shared` hands out `pg.Pool` as a type, and removing it breaks the typecheck.
 */
export const OUTSIDE_PROCESS_PACKAGES = ['pg'];

/** The one package allowed to declare them, as a repository-relative directory. */
export const OUTSIDE_PROCESS_HOME = 'shared';

/**
 * The compartment a repository-relative path belongs to, with the rule that governs it.
 *
 * `dir` is the compartment root — `modules/admin`, `shared`, `.` — and is what tells two modules
 * apart under the same `modules/*` rule.
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
