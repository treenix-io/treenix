// t.logs — unified log buffer, queryable via actions + MCP

import { getCtx, registerType } from '#comp';
import { KernelError } from '#errors';
import { interceptConsole, logStats, queryLogs, type LogLevel } from '#log';
import { loadSchemasFromDir } from '#schema/load';

interceptConsole();

// The buffer is process-wide, not the node's data: any user could create a
// t.logs node in their own subtree and read every server log through it.
function assertLogReader(): void {
  const { claims } = getCtx();
  if (!Array.isArray(claims) || (!claims.includes('admins') && !claims.includes('system'))) {
    throw new KernelError('FORBIDDEN', 't.logs: admin only');
  }
}

/** @description Server log buffer — query, literal grep, filter by level */
export class Logs {
  /** @read @description Query log buffer with literal grep, level filter, head/tail */
  async query(data: {
    /** Literal text to filter messages */ grep?: string;
    /** Log level(s) to include */ level?: LogLevel | LogLevel[];
    /** Return first N entries */ head?: number;
    /** Return last N entries */ tail?: number;
  }) {
    assertLogReader();
    return queryLogs(data);
  }

  /** @read @description Buffer stats: buffered count, total ever, max capacity */
  async stats() {
    assertLogReader();
    return logStats();
  }
}

registerType('t.logs', Logs);
loadSchemasFromDir(new URL('./schemas', import.meta.url).pathname);
