// Dev-onboarding helpers: auto-set VITE_DEV_LOGIN + MCP_DEV_ADMIN in NODE_ENV=development
// so a fresh clone is one command away from a working dev loop. Existing security gates
// (devLogin FORBIDDEN check, isDevAdminEnabled four-guard check) still enforce these flags
// — we only remove the manual-typing burden, not the in-code requirement.

export function applyDevDefaults(): void {
  if (process.env.NODE_ENV !== 'development') return;
  if (!process.env.VITE_DEV_LOGIN) process.env.VITE_DEV_LOGIN = '1';
  if (!process.env.MCP_DEV_ADMIN) process.env.MCP_DEV_ADMIN = '1';
}

export function devBannerLines(port: number): string[] | null {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.VITE_DEV_LOGIN !== '1' ||
    process.env.MCP_DEV_ADMIN !== '1'
  ) return null;
  const tty = process.stdout.isTTY;
  return [
    '',
    `${tty ? '\x1b[33m' : ''}⚠️  DEV MODE — UNAUTHORIZED ADMIN ACCESS ENABLED`,
    `   MCP: http://localhost:${port}/mcp`,
    '   Loopback only. Do not expose this port externally.',
    `   Disable: NODE_ENV=production (or MCP_DEV_ADMIN=0 / VITE_DEV_LOGIN=0)${tty ? '\x1b[0m' : ''}`,
    '',
  ];
}
