import { cancel, intro, isCancel, log, outro, spinner, text } from '@clack/prompts';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { modCreate } from './mod-create';

const STARTER_URL = process.env.TREENIX_STARTER_URL
  ?? 'https://codeload.github.com/treenix-io/starter/tar.gz/refs/heads/main';
const DOCS_URL = process.env.TREENIX_DOCS_URL
  ?? 'https://codeload.github.com/treenix-io/treenix/tar.gz/refs/heads/main';

async function downloadStarter(targetDir: string) {
  mkdirSync(targetDir, { recursive: true });
  const tgz = join(targetDir, '_starter.tgz');

  if (STARTER_URL.startsWith('file://')) {
    const localPath = STARTER_URL.slice('file://'.length);
    writeFileSync(tgz, readFileSync(localPath));
  } else {
    const res = await fetch(STARTER_URL);
    if (!res.ok) throw new Error(`Failed to download starter: HTTP ${res.status}`);
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  }

  try {
    execSync(`tar xzf "${tgz}" --strip-components=1 -C "${targetDir}"`, { stdio: 'ignore' });
  } finally {
    rmSync(tgz, { force: true });
  }

  // Submodule refs don't resolve from tar.gz — remove starter-dev artifact.
  const gitmodules = join(targetDir, '.gitmodules');
  if (existsSync(gitmodules)) rmSync(gitmodules);

  // Lockfile from starter repo pins its snapshot versions; drop it so install
  // resolves to the latest versions satisfying package.json semver ranges.
  const lock = join(targetDir, 'package-lock.json');
  if (existsSync(lock)) rmSync(lock);
}

/** Overlay docs/ from the main treenix repo (latest authoritative content)
 *  on top of the starter's minimal docs snapshot. Best-effort: failure is
 *  logged but doesn't abort scaffolding. */
async function downloadDocs(targetDir: string) {
  const tgz = join(targetDir, '_docs.tgz');
  const tmpExtract = join(targetDir, '_docs_extract');

  try {
    if (DOCS_URL.startsWith('file://')) {
      writeFileSync(tgz, readFileSync(DOCS_URL.slice('file://'.length)));
    } else {
      const res = await fetch(DOCS_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    }

    mkdirSync(tmpExtract, { recursive: true });
    // Extract only `<repo>-<sha>/docs/*` into tmpExtract/docs
    execSync(
      `tar xzf "${tgz}" --strip-components=1 -C "${tmpExtract}" "$(tar tzf "${tgz}" | head -1)docs"`,
      { stdio: 'ignore', shell: '/bin/bash' },
    );
    // Move/overlay onto targetDir/docs
    const src = join(tmpExtract, 'docs');
    if (existsSync(src)) {
      execSync(`mkdir -p "${join(targetDir, 'docs')}" && cp -R "${src}/." "${join(targetDir, 'docs')}/"`, {
        stdio: 'ignore',
        shell: '/bin/bash',
      });
    }
  } catch (e) {
    log.warn(`Could not fetch docs from main repo (${(e as Error).message}); keeping starter docs only`);
  } finally {
    rmSync(tgz, { force: true });
    rmSync(tmpExtract, { recursive: true, force: true });
  }
}

function rewritePackageName(targetDir: string, name: string) {
  const pkgPath = join(targetDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.name = name;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

function normalizeName(raw: string): string {
  return basename(raw).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'treenix-app';
}

function detectPm(): 'npm' | 'pnpm' | 'bun' {
  const ua = process.env.npm_config_user_agent ?? '';
  if (ua.startsWith('bun')) return 'bun';
  if (ua.startsWith('pnpm')) return 'pnpm';
  return 'npm';
}

function installDeps(targetDir: string, pm: string) {
  execSync(`${pm} install`, { cwd: targetDir, stdio: 'inherit' });
}

// --- Subcommand: mod create ---
const sub = process.argv[2];

if (sub === 'mod') {
  const action = process.argv[3];
  if (action !== 'create') {
    log.error(`Unknown mod action "${action}". Usage: create-treenix mod create <name>`);
    process.exit(1);
  }
  const yes = process.argv.includes('-y') || process.argv.includes('--yes');
  const rest = process.argv.slice(4).filter(a => !a.startsWith('-'));
  intro('create-treenix mod');
  await modCreate(rest, yes);
  outro('Done!');
  process.exit(0);
}

// --- Subcommand: start (ephemeral playground) ---
if (sub === 'start') {
  const reset = process.argv.includes('--reset');
  const playDir = join(homedir(), '.cache', 'treenix', 'play');
  const pm = detectPm();

  if (reset && existsSync(playDir)) {
    rmSync(playDir, { recursive: true, force: true });
  }

  intro('create-treenix start');

  if (!existsSync(playDir)) {
    const s = spinner();
    s.start('Downloading starter...');
    await downloadStarter(playDir);
    rewritePackageName(playDir, 'treenix-play');
    s.stop('Starter ready.');

    log.step(`Installing dependencies (one-time) via ${pm}...`);
    try { installDeps(playDir, pm); } catch {
      log.error(`Install failed. Run \`${pm} install\` in ${playDir}`);
      process.exit(1);
    }
    log.success('Dependencies installed.');
  } else {
    log.info(`Reusing playground at ${playDir} (--reset to wipe)`);
  }

  outro('Starting dev server...');
  execSync(pm === 'npm' ? 'npm run dev' : `${pm} dev`, { cwd: playDir, stdio: 'inherit' });
  process.exit(0);
}

// --- Default: create-treenix [name] [-y] ---
const args = process.argv.slice(2);
const yes = args.includes('-y') || args.includes('--yes');
const rawName = args.find(a => !a.startsWith('-'));

if (!yes) intro('create-treenix');

let input = rawName;
if (!input && !yes) {
  const result = await text({
    message: 'Project name',
    placeholder: 'my-treenix-app',
    validate: v => v.length === 0 ? 'Required' : undefined,
  });
  if (isCancel(result)) { cancel(); process.exit(0); }
  input = String(result);
}
input ??= 'my-treenix-app';

const targetDir = resolve(input);
const pkgName = normalizeName(input);

if (existsSync(targetDir)) {
  log.error(`Directory "${basename(targetDir)}" already exists.`);
  process.exit(1);
}

const s = yes ? null : spinner();
s?.start('Downloading starter...');
try {
  await downloadStarter(targetDir);
  rewritePackageName(targetDir, pkgName);
} catch (e) {
  s?.stop('Download failed.');
  log.error((e as Error).message);
  rmSync(targetDir, { recursive: true, force: true });
  process.exit(1);
}
await downloadDocs(targetDir);
s?.stop('Project created.');

const pm = detectPm();
if (s) log.step(`Installing dependencies via ${pm}...`);
else console.log(`Installing dependencies via ${pm}...`);
try {
  installDeps(targetDir, pm);
  if (s) log.success('Dependencies installed.');
  else console.log('Dependencies installed.');
} catch {
  if (s) log.error(`Install failed. Run \`${pm} install\` manually.`);
  else console.log(`Install failed. Run \`${pm} install\` manually.`);
}

const runCmd = pm === 'npm' ? 'npm run dev' : `${pm} dev`;
const next = `cd ${basename(targetDir)}\n  ${runCmd}`;

if (!yes) outro(`Done! Next steps:\n\n  ${next}`);
else console.log(`Done!\n  ${next}`);
