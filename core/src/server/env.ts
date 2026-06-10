// Must stay main.ts's FIRST import. Modules read process.env at module top level
// (actions.ts ACTION_TIMEOUT/STREAM_TIMEOUT), and ESM evaluates imports before the
// importer's body — a loadEnvFile() statement in main.ts would run too late.
// Like dotenv, loadEnvFile never overrides variables already set in the shell.
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
