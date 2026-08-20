#!/usr/bin/env node
/**
 * Boundary check: what a file may import, and whether it reads the environment. The rules are in
 * `workspace-rules.mjs`, and the walk covers the whole repository, so `shared/` reaching into a
 * module is caught by the same rule as the reverse.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import {
  allows,
  compartmentOf,
  describeAllowance,
  repoRoot,
  workspacePackages,
} from './workspace-rules.mjs';

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
  'playwright-report',
  'test-results',
]);
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Areas forbidden to read the environment directly — the one boundary the move genuinely weakened,
 * because roles say nothing about credentials read out of `process.env`: a neighbour's
 * `DB_PASSWORD_<MODULE>` opens that neighbour's database, and `DATABASE_URL` opens every one of them
 * as the role that owns the server. The second line is in the composer, which deletes both once
 * handed out.
 */
const ENV_FORBIDDEN_AREAS = ['modules/*'];

/**
 * The door a neighbour comes through, and the one file that must carry nothing at runtime.
 * `exports` says which file may be opened and never what is inside, so this check says the rest: in
 * that one file, every export and every import must be type-only.
 */
const DOOR_FILE = /^modules\/[^/]+\/src\/contract\.ts$/;

/**
 * The two files a browser bundle may read from `shared`. A bundler follows imports, not manifests,
 * so one `import { intEnv } from './env.js'` and `process.env` follows it into a page, where the
 * failure is a blank screen and not a build error.
 */
const BROWSER_SAFE_FILES = /^shared\/src\/(theme|vocabulary)\.ts$/;
const BROWSER_SAFE_IMPORTS = new Set(['zod']);

const packages = workspacePackages();
const packageNames = new Set(packages.map((entry) => entry.name));
const nameOfDir = new Map(packages.map((entry) => [entry.dir, entry.name]));

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) walk(full, files);
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

/** Repository-relative path with forward slashes, which is how the rule table is written. */
function repoRelative(file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

/** The workspace package a bare specifier names, or null for a third-party or node: import. */
function workspacePackageOf(specifier) {
  const scoped = /^(@[^/]+\/[^/]+)/.exec(specifier);
  const name = scoped ? scoped[1] : specifier.split('/')[0];
  return packageNames.has(name) ? name : null;
}

const importProblems = [];
const envProblems = [];
const doorProblems = [];
const emitProblems = [];
const unbuiltDoors = [];
const browserProblems = [];

function inspect(file) {
  const relative = repoRelative(file);
  const { rule, dir } = compartmentOf(relative);
  const ownName = nameOfDir.get(dir) ?? null;

  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

  const at = (node) => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${relative}:${position.line + 1}:${position.character + 1}`;
  };

  const literal = (node) => (node && ts.isStringLiteralLike(node) ? node.text : null);

  const recordImport = (node, specifier, kind) => {
    const target = workspacePackageOf(specifier);

    if (target) {
      if (target === ownName || allows(rule, target, specifier)) return;
      importProblems.push(
        `${at(node)} ${kind} of "${specifier}": ${rule.area} may use ${describeAllowance(rule)}`,
      );
      return;
    }

    if (!specifier.startsWith('.')) return;

    const resolved = repoRelative(path.resolve(path.dirname(file), specifier));
    if (resolved.startsWith('..')) return;

    const there = compartmentOf(resolved);
    if (there.dir === dir) return;

    importProblems.push(
      `${at(node)} ${kind} of "${specifier}" leaves ${dir} and lands in ${there.dir}; ` +
        'reach a package by its name, not by a relative path',
    );
  };

  const readsEnvironment =
    ENV_FORBIDDEN_AREAS.includes(rule.area) && !/\.test\.tsx?$/.test(relative);

  const visit = (node) => {
    if (
      readsEnvironment &&
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'env' &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process'
    ) {
      envProblems.push(`${at(node)} reads process.env in ${dir}`);
    }

    if (ts.isImportDeclaration(node)) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier) {
        recordImport(node, specifier, node.importClause?.isTypeOnly ? 'type import' : 'import');
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier) recordImport(node, specifier, 're-export');
    } else if (ts.isCallExpression(node)) {
      const specifier = literal(node.arguments[0]);
      if (specifier && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        recordImport(node, specifier, 'dynamic import');
      }
      if (specifier && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        recordImport(node, specifier, 'require');
      }
    }
    ts.forEachChild(node, visit);
  };

  if (DOOR_FILE.test(relative)) {
    inspectDoor(relative, source, at);
    inspectDoorEmit(relative);
  }

  if (BROWSER_SAFE_FILES.test(relative)) {
    for (const statement of source.statements) {
      const specifier =
        (ts.isImportDeclaration(statement) || (ts.isExportDeclaration(statement) && statement.moduleSpecifier))
          ? literalOf(statement.moduleSpecifier)
          : null;
      if (specifier && !BROWSER_SAFE_IMPORTS.has(specifier)) {
        browserProblems.push(`${at(statement)} imports "${specifier}"`);
      }
    }
  }

  visit(source);
}

/** The string of a module specifier node, or null when it is not a plain literal. */
function literalOf(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

/**
 * Everything in the door must be a declaration. `export { AuthPublicRouter }` without `type` is the
 * case worth naming: it looks identical in the editor and type-checks, but the emitted file keeps
 * the re-export, so the door starts pulling `./routers/public.js` into whoever opened it.
 */
function inspectDoor(relative, source, at) {
  const say = (node, what) => doorProblems.push(`${at(node)} ${what}`);

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.isTypeOnly) say(statement, 'export is not type-only — write `export type {…}`');
      continue;
    }

    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause?.isTypeOnly) {
        say(statement, 'import is not type-only — write `import type {…}`');
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      say(statement, 'default export — the door exports declarations, not values');
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) continue;

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      say(statement, 'exports a value — only types may leave through the door');
    }
  }
}

/**
 * The same rule from the other side: not how the door is written, but what it emits.
 *
 * The check above reads the source and knows the forms that would carry code; this one knows none of
 * them and asks the built file to be `export {};`. That covers what a list of forms cannot: a `const`
 * nobody exports, written to derive a type from it, exports nothing and still emits the value.
 *
 * It runs after `build`, which is where it sits in `pnpm check`. Standing alone it refuses rather
 * than skips: a check that quietly does nothing is worse than one that says it cannot run.
 */
function inspectDoorEmit(relative) {
  const built = relative.replace('/src/', '/dist/').replace(/\.ts$/, '.js');
  const full = path.join(repoRoot, built);

  let emitted;
  try {
    emitted = readFileSync(full, 'utf8');
  } catch {
    unbuiltDoors.push(built);
    return;
  }

  const code = emitted
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'))
    .join(' ');

  if (code !== 'export {};') emitProblems.push(`${built} emits ${JSON.stringify(code)}`);
}

const files = walk(repoRoot);
for (const file of files) inspect(file);

if (importProblems.length > 0) {
  console.error('Imports that cross a boundary:');
  for (const problem of importProblems) console.error(`- ${problem}`);
  console.error(
    '\nUse @template/shared, or a neighbour as @template/<name>/contract, and call through it.',
  );
}

if (envProblems.length > 0) {
  const separator = importProblems.length > 0 ? '\n' : '';
  console.error(`${separator}Modules reading the environment:`);
  for (const problem of envProblems) console.error(`- ${problem}`);
  console.error('\nA module is handed what it needs; the composer is what reads the environment.');
}

if (browserProblems.length > 0) {
  const earlier = importProblems.length > 0 || envProblems.length > 0;
  console.error(`${earlier ? '\n' : ''}Browser-facing files reaching into the server:`);
  for (const problem of browserProblems) console.error(`- ${problem}`);
  console.error(
    `\n${'shared/src/theme.ts and shared/src/vocabulary.ts are published to browser bundles; '}` +
      'they may import zod and nothing else, or pg and process.env follow them into a page.',
  );
}

if (doorProblems.length > 0) {
  const earlier = importProblems.length > 0 || envProblems.length > 0;
  console.error(`${earlier ? '\n' : ''}Doors that would carry code:`);
  for (const problem of doorProblems) console.error(`- ${problem}`);
  console.error(
    '\nmodules/*/src/contract.ts is the only file a neighbour may import; it must compile to ' +
      '`export {};` so the type crosses the boundary and the implementation does not.',
  );
}

const earlierProblem = () =>
  importProblems.length > 0 ||
  envProblems.length > 0 ||
  doorProblems.length > 0 ||
  browserProblems.length > 0;

if (emitProblems.length > 0) {
  console.error(`${earlierProblem() ? '\n' : ''}Doors that carry code once built:`);
  for (const problem of emitProblems) console.error(`- ${problem}`);
  console.error(
    '\nA door is allowed to emit `export {};` and nothing else. Whatever is left in it runs when ' +
      'a neighbour loads the door, and travels into every bundle that follows the type.',
  );
}

if (unbuiltDoors.length > 0) {
  console.error(`${earlierProblem() || emitProblems.length > 0 ? '\n' : ''}Doors not built yet:`);
  for (const door of unbuiltDoors) console.error(`- ${door}`);
  console.error('\nWhat a door emits is only visible after pnpm build; run it and repeat.');
}

if (
  importProblems.length > 0 ||
  envProblems.length > 0 ||
  doorProblems.length > 0 ||
  emitProblems.length > 0 ||
  unbuiltDoors.length > 0 ||
  browserProblems.length > 0
) {
  process.exit(1);
}

console.log(`Boundary check passed (${packages.length} packages, ${files.length} files).`);
