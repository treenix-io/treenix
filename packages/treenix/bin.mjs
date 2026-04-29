#!/usr/bin/env node

import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const args = process.argv.slice(2);
const cmd = args[0];

// ── treenix init [name] ──
if (cmd === 'init') {
  const name = args[1] || 'my-treenix-app';
  const target = resolve(name);

  if (existsSync(target)) {
    console.error(`Error: "${name}" already exists.`);
    process.exit(1);
  }

  console.log(`\n  Creating ${name}...\n`);
  execSync(
    `git clone --recurse-submodules --depth 1 https://github.com/treenix-io/starter.git ${name}`,
    { stdio: 'inherit' },
  );

  // Remove .git so it's a fresh project, not a clone
  execSync(`rm -rf ${name}/.git`);

  console.log('\n  Installing dependencies...\n');
  execSync('npm install', { cwd: target, stdio: 'inherit' });

  console.log(`
  Done! Next:

    cd ${name}
    npx treenix
`);
  process.exit(0);
}

// ── treenix (default: run server + frontend) ──

const rootJson = resolve('root.json');
if (!existsSync(rootJson)) {
  console.error(`
  No root.json found in current directory.

  To create a new project:
    npx treenix init my-app

  To run an existing project:
    cd your-treenix-project && npx treenix
`);
  process.exit(1);
}

// Find server entry
const serverPath = resolve('engine/core/src/server/main.ts');
if (!existsSync(serverPath)) {
  console.error('engine/core/src/server/main.ts not found. Is this a Treenix project?');
  process.exit(1);
}

console.log('\n  Starting Treenix...\n');

// Start server
const server = spawn('npx', ['tsx', '--conditions', 'development', '--watch', serverPath, 'root.json'], {
  stdio: 'inherit',
  cwd: process.cwd(),
});

// Start frontend if @treenx/react is available
const frontPkg = resolve('engine/packages/react/package.json');
if (existsSync(frontPkg)) {
  // Small delay so server is up before vite tries to proxy
  setTimeout(() => {
    const front = spawn('npm', ['run', 'dev', '-w', '@treenx/react'], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    front.on('error', () => {}); // frontend is optional
  }, 1000);
}

// Clean exit
process.on('SIGINT', () => {
  server.kill('SIGINT');
  process.exit(0);
});
process.on('SIGTERM', () => {
  server.kill('SIGTERM');
  process.exit(0);
});

server.on('exit', (code) => process.exit(code ?? 0));
