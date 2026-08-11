#!/usr/bin/env node
/**
 * Boundary check: what a file may import, and which database a module may open.
 *
 * The rules are not in this file. They are in `workspace-rules.mjs`, written out as a table, next
 * to the same rules seen from the manifest side in `check-dependencies.mjs` — a rule that lives in
 * two places is a rule that will be changed in one of them.
 *
 * A module may import its own folder, `contracts/`, `shared/` and third-party packages. Importing a
 * neighbouring module is forbidden, including type-only imports: a type shared by two modules
 * belongs in `contracts/`. Cross-module calls go through the contracts.
 *
 * The walk covers the whole repository, not only the modules, so that `shared/` reaching into a
 * module or a script reaching into a package is caught by the same rule as the reverse.
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
 * Areas allowed to open a database pool. The composer wires; a module is handed what it needs.
 *
 * `createAdminPool` is on the same list and is the more dangerous of the two: it opens whatever
 * connection string it is given, as the role that owns the server. It lives behind the subpath
 * `@template/shared/admin` so it never turns up in completions, and this is the check behind that.
 *
 * `tests` is on the list for one check and one only — that a module's credentials are refused a
 * neighbour's database. Everything else in that suite goes through Gateway on purpose, because a
 * test that reaches into the database proves the database works and says nothing about whether the
 * request would have been allowed.
 */
const POOL_CALLERS = ['composition', 'tests'];
const POOL_FUNCTIONS = ['createPool', 'createAdminPool'];

/**
 * Areas forbidden to read the environment directly.
 *
 * This is the first line of the one boundary the move genuinely weakened. Compose used to hand each
 * container only its own variables — the mail key existed for `email` and nowhere else — and in one
 * process `process.env` is shared by everyone in it. Roles on the database do not cover this: they
 * stop a module connecting to a neighbour's database with its own credentials, but credentials read
 * out of the environment would let it connect as the owner.
 *
 * So a module is handed what it needs and does not look. `shared` reads the environment on purpose —
 * that is where the typed access lives — and a test may set a variable to check the code that reads
 * it. The second line is in the composer, which deletes the single-module secrets once they have
 * been handed out.
 */
const ENV_FORBIDDEN_AREAS = ['modules/*'];

/**
 * The door a neighbour comes through, and the one file that must carry nothing at runtime.
 *
 * With tRPC a client is typed from the server's router, so the type has to leave the module. That
 * is what `exports: "./contract"` opens, and what the rule above lets a neighbour import. The
 * permission is affordable for exactly one reason: the door hands over declarations and no code —
 * every one of these files compiles to `export {};`.
 *
 * One value export ends that. Re-export the router instead of its type and the door starts handing
 * out routers, repositories and `pg`; `exports` would still name a single entry and would still be
 * satisfied, because it says which file may be opened and never what is inside. A neighbour that
 * imports the door would pull the implementation into its own build — `app/web` into a browser
 * bundle — with nothing red anywhere.
 *
 * So the check is narrow on purpose: in this one file, every export and every import must be
 * type-only. It is the counterpart of the `web` lint rule, which guards the other route into `src`.
 */
const DOOR_FILE = /^modules\/[^/]+\/src\/contract\.ts$/;

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
const poolProblems = [];
const envProblems = [];
const doorProblems = [];

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

  /**
   * The composer creates all five pools and hands each module a ready one, so the call may only
   * appear where the permission already is — a module cannot pass the wrong name because it cannot ask.
   */
  const recordPool = (node, name) => {
    if (!POOL_CALLERS.includes(rule.area)) {
      poolProblems.push(`${at(node)} ${name}() in ${dir}`);
    }
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
      if (ts.isIdentifier(node.expression) && POOL_FUNCTIONS.includes(node.expression.text)) {
        recordPool(node, node.expression.text);
      }
    }
    ts.forEachChild(node, visit);
  };

  if (DOOR_FILE.test(relative)) inspectDoor(relative, source, at);

  visit(source);
}

/**
 * Everything in the door must be a declaration. Anything else is code that would be emitted.
 *
 * `export { AuthPublicRouter }` without `type` is the case worth naming: it looks identical in the
 * editor and type-checks, but the emitted file keeps the re-export, so the door stops being empty
 * and starts pulling `./routers/public.js` — and everything it imports — into whoever opened it.
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

const files = walk(repoRoot);
for (const file of files) inspect(file);

if (importProblems.length > 0) {
  console.error('Imports that cross a boundary:');
  for (const problem of importProblems) console.error(`- ${problem}`);
  console.error('\nUse @template/contracts or @template/shared, and call through the contracts.');
}

if (poolProblems.length > 0) {
  console.error(`${importProblems.length > 0 ? '\n' : ''}Database pools opened outside the wiring:`);
  for (const problem of poolProblems) console.error(`- ${problem}`);
  console.error(
    `\n${POOL_FUNCTIONS.join('() and ')}() belong to ${POOL_CALLERS.join(', ')}; ` +
      'a module is handed its pool.',
  );
}

if (envProblems.length > 0) {
  const separator = importProblems.length > 0 || poolProblems.length > 0 ? '\n' : '';
  console.error(`${separator}Modules reading the environment:`);
  for (const problem of envProblems) console.error(`- ${problem}`);
  console.error('\nA module is handed what it needs; the composer is what reads the environment.');
}

if (doorProblems.length > 0) {
  const earlier = importProblems.length > 0 || poolProblems.length > 0 || envProblems.length > 0;
  console.error(`${earlier ? '\n' : ''}Doors that would carry code:`);
  for (const problem of doorProblems) console.error(`- ${problem}`);
  console.error(
    '\nmodules/*/src/contract.ts is the only file a neighbour may import; it must compile to ' +
      '`export {};` so the type crosses the boundary and the implementation does not.',
  );
}

if (
  importProblems.length > 0 ||
  poolProblems.length > 0 ||
  envProblems.length > 0 ||
  doorProblems.length > 0
) {
  process.exit(1);
}

console.log(`Boundary check passed (${packages.length} packages, ${files.length} files).`);
