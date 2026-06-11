// treenix backup|verify|restore — stop-the-world instance backup (core-gk8.9).
// Run from the server's CWD: mount roots in root.json are CWD-relative, exactly
// as createFsTree resolves them. Contract: docs/deployment.md "Backup & restore".

import { backupInstance, restoreArtifact, verifyArtifact } from './backup';

const USAGE = `treenix — instance backup/restore (stop the server first)

  treenix backup  [root.json] [outDir]      create artifact dir (default: ./root.json → ./backups/)
  treenix verify  <artifactDir>             check artifact coherence (read-only)
  treenix restore <artifactDir> [--into d] [--replace]
                                            restore dirs + config; --replace moves
                                            existing non-empty dirs aside, never deletes
`;

const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === 'backup') {
    await backupInstance(rest[0] ?? 'root.json', rest[1] ?? 'backups');
  } else if (cmd === 'verify') {
    if (!rest[0]) throw new Error(USAGE);
    const m = await verifyArtifact(rest[0]);
    console.log(`[verify] artifact ok: ${m.dirs.length} dirs, created ${m.createdAt}, engine ${m.engineVersion}`);
    if (m.external.length) console.log(`[verify] external stores NOT in artifact: ${m.external.map((x) => x.type).join(', ')}`);
  } else if (cmd === 'restore') {
    if (!rest[0]) throw new Error(USAGE);
    const into = rest.includes('--into') ? rest[rest.indexOf('--into') + 1] : undefined;
    if (rest.includes('--into') && (!into || into.startsWith('--'))) throw new Error(USAGE);
    await restoreArtifact(rest[0], { into, replace: rest.includes('--replace') });
    console.log('[restore] start the server to complete recovery (boot re-runs migrations and trash GC)');
  } else {
    console.error(USAGE);
    process.exit(2);
  }
} catch (e) {
  console.error(`[treenix] FAILED: ${(e as Error).message}`);
  process.exit(1);
}
