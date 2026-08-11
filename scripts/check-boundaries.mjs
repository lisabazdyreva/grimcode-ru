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

import { compartmentOf, repoRoot, workspacePackages } from './workspace-rules.mjs';

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

function inspect(file) {
  const relative = repoRelative(file);
  const { rule, dir } = compartmentOf(relative);
  const ownName = nameOfDir.get(dir) ?? null;
  const isModule = rule.area === 'services/*';

  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

  const at = (node) => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${relative}:${position.line + 1}:${position.character + 1}`;
  };

  const literal = (node) => (node && ts.isStringLiteralLike(node) ? node.text : null);

  const recordImport = (node, specifier, kind) => {
    const target = workspacePackageOf(specifier);

    if (target) {
      if (target === ownName || rule.mayUse.includes(target)) return;
      importProblems.push(
        `${at(node)} ${kind} of "${specifier}": ${rule.area} may use ` +
          `${rule.mayUse.length > 0 ? rule.mayUse.join(', ') : 'no workspace package'}`,
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
   * `createPool('<module>')` names the database a module opens, and the only name it may pass is
   * its own — the string is the whole of the choice, and nothing else in the repository checks it.
   *
   * The sixth stage replaces this with a stricter rule, "no call outside `composition/`", once the
   * pools are created by the wiring rather than by the modules. Until then the literal is what
   * there is to check.
   */
  const recordPool = (node) => {
    if (!isModule) {
      poolProblems.push(`${at(node)} createPool() outside a module`);
      return;
    }

    const expected = dir.split('/').at(-1);
    const argument = node.arguments.length === 1 ? literal(node.arguments[0]) : null;

    if (argument === null) {
      poolProblems.push(
        `${at(node)} createPool() must be called with one string literal, ` +
          `and for this module it is '${expected}'`,
      );
    } else if (argument !== expected) {
      poolProblems.push(`${at(node)} createPool('${argument}') in module "${expected}"`);
    }
  };

  const visit = (node) => {
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
      if (ts.isIdentifier(node.expression) && node.expression.text === 'createPool') {
        recordPool(node);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
}

const files = walk(repoRoot);
for (const file of files) inspect(file);

if (importProblems.length > 0) {
  console.error('Imports that cross a boundary:');
  for (const problem of importProblems) console.error(`- ${problem}`);
  console.error('\nUse @template/contracts or @template/shared, and call through the contracts.');
}

if (poolProblems.length > 0) {
  console.error(`${importProblems.length > 0 ? '\n' : ''}Database pools opened under a wrong name:`);
  for (const problem of poolProblems) console.error(`- ${problem}`);
  console.error('\nA module opens its own database and no other.');
}

if (importProblems.length > 0 || poolProblems.length > 0) process.exit(1);

console.log(`Boundary check passed (${packages.length} packages, ${files.length} files).`);
