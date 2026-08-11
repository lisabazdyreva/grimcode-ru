#!/usr/bin/env node
/**
 * What a package may declare, and what keeps `node_modules` isolated.
 *
 * `check-boundaries.mjs` reads imports; a third-party package is invisible to it — `pg` is the same
 * kind of import as `zod`. This check reads the manifests instead, where the difference is visible:
 * a module that declares the database driver can open a connection past `shared`, whether or not it
 * does today. The rules themselves live in `workspace-rules.mjs`, next to the import rules they
 * mirror.
 *
 * Two details that decide whether the check works at all:
 *
 * - **every dependency section, not just `dependencies`.** A rule that reads one section is a rule
 *   that is obeyed by moving a line into another one. `devDependencies` is used honestly here —
 *   `modules/app` keeps `@template/contracts` there because vite compiles it in and the runtime
 *   image does not need it — so the sections cannot be told apart by intent either.
 * - **only the two rules below.** Nothing here says a module may not depend on `@orpc/*`, `react`
 *   or `zod`. The subject is reaching out of the process and reaching into a neighbour, not
 *   dependencies in general; a check that goes red on honest code teaches whoever meets it to
 *   loosen the rule instead of describing the exception.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  compartmentOf,
  OUTSIDE_PROCESS_HOME,
  OUTSIDE_PROCESS_PACKAGES,
  repoRoot,
  workspacePackages,
} from './workspace-rules.mjs';

/**
 * Sections whose entries pnpm installs and therefore makes resolvable. `peerDependencies` is on the
 * list because `.npmrc` sets `auto-install-peers=true`: a peer is installed like any other
 * dependency, so it grants exactly the same access.
 */
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * `.npmrc` settings that would undo the isolation of `node_modules` in one line. The whole boundary
 * rests on it: a module cannot import what pnpm did not link into its own `node_modules`, and
 * hoisting to the root puts every package within reach of every other one with nothing to notice.
 */
const NPMRC_RULES = [
  {
    key: 'shamefully-hoist',
    refuse: (value) => value === 'true',
    why: 'it links every package into the root node_modules, where any module can import it',
  },
  {
    key: 'node-linker',
    refuse: (value) => value !== 'isolated',
    why: 'only the isolated linker gives each package a node_modules of its own',
  },
  {
    key: 'public-hoist-pattern',
    refuse: () => true,
    why: 'it lifts matching packages into the root node_modules, within reach of every module',
  },
];

const problems = [];

// --- what a package may declare -------------------------------------------------------------

const packages = workspacePackages();
const workspaceNames = new Set(packages.map((entry) => entry.name));

for (const { name, dir, manifest } of packages) {
  const { rule } = compartmentOf(dir);

  for (const section of SECTIONS) {
    for (const dependency of Object.keys(manifest[section] ?? {})) {
      if (workspaceNames.has(dependency) && dependency !== name) {
        if (!rule.mayUse.includes(dependency)) {
          problems.push(
            `${dir} declares "${dependency}" in ${section}; ${rule.area} may use ` +
              `${rule.mayUse.length > 0 ? rule.mayUse.join(', ') : 'no workspace package'}`,
          );
        }
      }

      if (OUTSIDE_PROCESS_PACKAGES.includes(dependency) && dir !== OUTSIDE_PROCESS_HOME) {
        problems.push(
          `${dir} declares "${dependency}" in ${section}; packages that reach outside the ` +
            `process belong to ${OUTSIDE_PROCESS_HOME}, which hands out what a module is allowed ` +
            'to use',
        );
      }
    }
  }
}

// --- what keeps node_modules isolated -------------------------------------------------------

const ignoredDirs = new Set([
  'node_modules',
  'dist',
  '.output',
  '.turbo',
  '.vite',
  'coverage',
  '.git',
  '.claude',
  '.idea',
  '.vscode',
]);

function npmrcFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) npmrcFiles(full, found);
    } else if (entry.isFile() && entry.name === '.npmrc') {
      found.push(full);
    }
  }
  return found;
}

const npmrcs = npmrcFiles(repoRoot);

for (const file of npmrcs) {
  const where = relative(repoRoot, file);

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    // `key[]=value` is how npmrc spells a list, and pnpm reads `public-hoist-pattern` that way.
    // Matching the plain name only would leave the setting reachable under its list spelling.
    const setting = /^\s*([\w.-]+)(\[\])?\s*=\s*(.*?)\s*$/.exec(line);
    if (!setting) continue;

    const [, key, , value] = setting;
    for (const rule of NPMRC_RULES) {
      if (key === rule.key && rule.refuse(value)) {
        problems.push(`${where} sets ${key}=${value}: ${rule.why}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('Dependency declarations that cross a boundary:');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(
  `Dependency check passed (${packages.length} packages, ${npmrcs.length} .npmrc ` +
    `file${npmrcs.length === 1 ? '' : 's'}).`,
);
