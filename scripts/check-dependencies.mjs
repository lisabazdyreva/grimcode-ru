#!/usr/bin/env node
/**
 * What a package may declare, and what keeps `node_modules` isolated.
 *
 * `check-boundaries.mjs` reads imports, and to it `pg` is the same kind of import as `zod`. This
 * check reads the manifests, where the difference is visible: a package that declares the database
 * driver can open a connection, whether or not it does today. The five modules that own a database
 * may; `app`, `site`, `gateway` and `tests` may not, and that is what this refuses.
 *
 * Every dependency section is read, not just `dependencies` — a rule that reads one section is
 * obeyed by moving a line into another. And only the two rules below: a check that goes red on
 * honest code teaches whoever meets it to loosen the rule instead of describing the exception.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  allows,
  compartmentOf,
  describeAllowance,
  OUTSIDE_PROCESS_HOMES,
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
      // A manifest cannot say "only this subpath", so declaring a neighbour is allowed wherever
      // the subpath is — and `check-boundaries.mjs` is what holds the other half of the rule, that
      // the only thing imported from it is `/contract`.
      const declarable =
        allows(rule, dependency) ||
        (rule.neighbourSubpath === true && workspaceNames.has(dependency));

      if (workspaceNames.has(dependency) && dependency !== name && !declarable) {
        problems.push(
          `${dir} declares "${dependency}" in ${section}; ` +
            `${rule.area} may use ${describeAllowance(rule)}`,
        );
      }

      if (OUTSIDE_PROCESS_PACKAGES.includes(dependency) && !OUTSIDE_PROCESS_HOMES.includes(dir)) {
        problems.push(
          `${dir} declares "${dependency}" in ${section}; the database driver belongs to a package ` +
            `that owns a database — ${OUTSIDE_PROCESS_HOMES.join(', ')} — and everything else is ` +
            'handed what it may use',
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
