#!/usr/bin/env node
/**
 * The local PostgreSQL this project develops against, without a package manager and without root.
 *
 * One server on this machine, shared by every checkout and every worktree — the slug in a database
 * name is what keeps two branches apart. If PostgreSQL is installed system-wide, use that instead:
 * this script exists for a machine where `sudo` is not available, which is the case in the sandboxes
 * this project is developed in.
 *
 * How it can work without root: a `.deb` is an archive. The official PostgreSQL packages are
 * unpacked into a directory of their own with `dpkg -x`, and `initdb` builds a cluster in the same
 * place. Nothing is installed into the system, nothing is registered with it, and removing the
 * directory removes every trace.
 *
 *   pnpm postgres setup     download the binaries and create the cluster
 *   pnpm postgres start     start the server
 *   pnpm postgres stop      stop it
 *   pnpm postgres status    say whether it is running, and where
 *   pnpm postgres psql …    a shell on it, with the arguments passed through
 *
 * The port and the account come from `DATABASE_URL` in `.env`, so the server is created where the
 * application already expects to find it — there is no second place to keep them in step.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** The major version to install. The same one the project has been developed against. */
const MAJOR = 17;

/**
 * Where the server lives.
 *
 * Outside the repository on purpose: it is one server for every worktree, and a data directory inside
 * a checkout would be copied by anything that copies the checkout. `~/.local/share` is where a program
 * without root keeps its state on Linux.
 */
const home = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'template-postgres');
const prefix = join(home, 'pg');
const dataDir = join(home, 'data');
const logFile = join(home, 'server.log');

/**
 * The directory for the unix socket, and why it is not next to the data.
 *
 * PostgreSQL refuses a socket path longer than 107 bytes, and a data directory under a worktree path
 * can exceed that on its own. `~/.pgrun` is short by construction, and the application connects over
 * TCP anyway — the socket is for `psql`.
 */
const runDir = join(homedir(), '.pgrun');

const bin = (name) => join(prefix, 'usr', 'lib', 'postgresql', String(MAJOR), 'bin', name);
const libs = join(prefix, 'usr', 'lib', debianArch() === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu');

function debianArch() {
  const machine = process.arch;
  if (machine === 'arm64') return 'arm64';
  if (machine === 'x64') return 'amd64';
  fail(`No PostgreSQL packages are published for ${machine}.`);
}

/** The Debian or Ubuntu release this machine is, as the package repository names it. */
function codename() {
  const release = readFileSync('/etc/os-release', 'utf8');
  const found = /^VERSION_CODENAME=(.+)$/m.exec(release);
  if (!found) fail('This machine does not say which release it is (VERSION_CODENAME in /etc/os-release).');
  return (found[1] ?? '').replace(/"/g, '');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * What `DATABASE_URL` says. Whatever the application connects to is what this script creates.
 *
 * `.env` is read as text rather than loaded: the file belongs to the application, and a script that
 * imported it would start deciding what a variable means.
 */
function connection() {
  const envFile = join(repoRoot, '.env');
  const source = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const line = /^\s*DATABASE_URL\s*=\s*(.+)$/m.exec(source);
  // `||`, not `??`: an empty DATABASE_URL in the environment is nothing to work with, and falling
  // through to `.env` is more useful than refusing with a file right there that has the answer.
  const raw = process.env.DATABASE_URL || line?.[1]?.trim().replace(/^["']|["']$/g, '');

  if (!raw) {
    fail('No DATABASE_URL, in the environment or in .env — this script takes the port and the account from it.');
  }

  const url = new URL(raw);
  return {
    port: url.port || '5432',
    user: decodeURIComponent(url.username || 'postgres'),
    password: decodeURIComponent(url.password || ''),
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
    env: { ...process.env, LD_LIBRARY_PATH: libs, ...options.env },
  });

  if (result.status !== 0) fail(`${command} failed with code ${result.status ?? 'signal'}.`);
  return result;
}

/** `pg_ctl status` as a boolean, without the noise it prints. */
function running() {
  if (!existsSync(bin('pg_ctl'))) return false;

  const result = spawnSync(bin('pg_ctl'), ['-D', dataDir, 'status'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LD_LIBRARY_PATH: libs },
  });
  return result.status === 0;
}

/**
 * The packages to unpack, found in the repository's own index rather than by guessing a file name.
 *
 * `Packages` is what a package manager reads: the current version of every package and where it
 * lives. Parsing it means this script keeps working when the version changes, which a hardcoded
 * `17.9-1.pgdg12+1` would not.
 */
function findPackages() {
  const arch = debianArch();
  const suite = `${codename()}-pgdg`;
  const base = 'https://apt.postgresql.org/pub/repos/apt';
  const index = `${base}/dists/${suite}/main/binary-${arch}/Packages.gz`;

  const listing = execFileSync('sh', ['-c', `curl -fsSL ${index} | gunzip`], {
    maxBuffer: 64 * 1024 * 1024,
  }).toString();

  const wanted = [`postgresql-${MAJOR}`, `postgresql-client-${MAJOR}`, 'libpq5'];
  const found = new Map();

  for (const block of listing.split('\n\n')) {
    const name = /^Package: (.+)$/m.exec(block)?.[1];
    const file = /^Filename: (.+)$/m.exec(block)?.[1];
    const version = /^Version: (.+)$/m.exec(block)?.[1] ?? '';

    // The index holds several builds of a package; the one for this release is the one to take.
    if (!name || !file || !wanted.includes(name)) continue;
    if (!file.includes(arch)) continue;
    if (found.has(name)) continue;

    found.set(name, { url: `${base}/${file}`, version });
  }

  for (const name of wanted) {
    if (!found.has(name)) fail(`The package repository has no ${name} for ${suite} on ${arch}.`);
  }

  return found;
}

function setup() {
  if (existsSync(bin('postgres')) && existsSync(join(dataDir, 'PG_VERSION'))) {
    console.log(`Already set up: PostgreSQL ${MAJOR} in ${home}. Nothing to do.`);
    return;
  }

  if (spawnSync('dpkg-deb', ['--version'], { stdio: 'ignore' }).status !== 0) {
    fail('This needs `dpkg-deb` to unpack the packages, and it is not on this machine.');
  }

  const { user, password, port } = connection();
  mkdirSync(home, { recursive: true });

  if (!existsSync(bin('postgres'))) {
    const packages = findPackages();
    const downloads = join(home, 'downloads');
    mkdirSync(downloads, { recursive: true });

    for (const [name, { url, version }] of packages) {
      const file = join(downloads, `${name}.deb`);
      console.log(`${name} ${version}`);
      run('curl', ['-fsSL', '-o', file, url]);
      run('dpkg-deb', ['-x', file, prefix]);
    }

    // The archives are of no use once unpacked, and they are the bulk of what this takes on disk.
    rmSync(downloads, { recursive: true, force: true });
  }

  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    mkdirSync(runDir, { recursive: true });

    /*
     * `trust` on the socket, a password over TCP. The application connects over TCP with the password
     * from `DATABASE_URL`, so authentication has to behave the way it will in production; the socket
     * is only ever reached by a person on this machine, who already has the data directory.
     */
    run(bin('initdb'), [
      '-D',
      dataDir,
      '-U',
      user,
      '--auth-local=trust',
      '--auth-host=scram-sha-256',
      '-E',
      'UTF8',
    ]);
  }

  start();

  if (password) {
    // Set through the socket, where no password is needed yet — this is what makes the URL's work.
    run(bin('psql'), ['-h', runDir, '-p', port, '-U', user, '-d', 'postgres', '-c', 'ALTER USER ' +
      quoteIdentifier(user) + ' PASSWORD ' + quoteLiteral(password)], { stdio: 'ignore' });
    console.log('Password set from DATABASE_URL.');
  }

  console.log(`Ready. PostgreSQL ${MAJOR} in ${home}, listening on 127.0.0.1:${port}.`);
}

/** SQL quoting for the two values that reach a statement here, both from `.env`. */
function quoteIdentifier(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function start() {
  if (!existsSync(bin('pg_ctl'))) fail('Not set up yet — run `pnpm postgres setup` first.');
  if (running()) {
    console.log('Already running.');
    return;
  }

  const { port } = connection();
  mkdirSync(runDir, { recursive: true });

  run(bin('pg_ctl'), ['-D', dataDir, '-o', `-p ${port} -k ${runDir}`, '-l', logFile, 'start']);
}

function stop() {
  if (!running()) {
    console.log('Not running.');
    return;
  }
  run(bin('pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop']);
}

/**
 * `psql` against this server, with the arguments a person adds.
 *
 * Here rather than in the README, because these binaries are not on the `PATH` and do not find their
 * own libraries: `psql` run by hand fails with `libpq.so.5: cannot open shared object file`, which
 * says nothing about what is missing. Everything after the command is passed through, so
 * `pnpm postgres psql -l` and `pnpm postgres psql -d slug_auth -c '…'` work as they read.
 */
function psql() {
  if (!existsSync(bin('psql'))) fail('Not set up yet — run `pnpm postgres setup` first.');

  const { port, user } = connection();
  const args = process.argv.slice(3);
  const addressed = args.some((argument) => argument === '-h' || argument.startsWith('--host'));

  /*
   * The defaults go first and what a person typed goes after, so their `-d` or `-p` wins — psql takes
   * the last one. Without a default `-d` it would look for a database named after the account, which
   * does not exist here and fails with a message about the wrong thing.
   */
  run(bin('psql'), [
    ...(addressed ? [] : ['-h', runDir, '-p', port, '-U', user]),
    '-d',
    'postgres',
    ...args,
  ]);
}

/**
 * The port the running server actually listens on.
 *
 * `postmaster.pid` is where PostgreSQL writes it: the fourth line, after the pid, the data directory
 * and the start time. Read rather than assumed, because the port is decided when the server starts and
 * `DATABASE_URL` can have been edited since.
 */
function listeningOn() {
  const pidFile = join(dataDir, 'postmaster.pid');
  if (!existsSync(pidFile)) return null;
  return readFileSync(pidFile, 'utf8').split('\n')[3]?.trim() ?? null;
}

function status() {
  const { port, user } = connection();
  console.log(`Directory: ${home}`);
  console.log(`Log:       ${logFile}`);
  console.log(`Expected:  127.0.0.1:${port} as ${user} (from DATABASE_URL)`);

  if (!existsSync(bin('postgres'))) {
    console.log('State:     not set up');
    return;
  }

  if (!running()) {
    console.log('State:     stopped');
    return;
  }

  const actual = listeningOn();
  console.log(`State:     running on ${actual ?? 'an unknown port'}`);

  // Started before DATABASE_URL was changed, or pointed at another server entirely — either way the
  // application is not talking to this one, and "running" on its own would read as if it were.
  if (actual && actual !== port) {
    console.log(`Mismatch:  the application expects ${port}; restart to move this server there.`);
  }
}

const command = process.argv[2] ?? 'status';
const commands = { setup, start, stop, status, psql };

if (!(command in commands)) {
  fail(`Usage: pnpm postgres ${Object.keys(commands).join(' | ')}`);
}

commands[command]();
