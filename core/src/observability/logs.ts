// t.logs — unified log buffer, queryable via actions + MCP

import { registerType } from '#comp';
import { interceptConsole, logStats, queryLogs, type LogLevel } from '#log';
import { loadSchemasFromDir } from '#schema/load';

interceptConsole();

/** @description Server log buffer — query, literal grep, filter by level */
export class Logs {
  /** @read @description Query log buffer with literal grep, level filter, head/tail */
  async query(data: {
    /** Literal text to filter messages */ grep?: string;
    /** Log level(s) to include */ level?: LogLevel | LogLevel[];
    /** Return first N entries */ head?: number;
    /** Return last N entries */ tail?: number;
  }) {
    return queryLogs(data);
  }

  /** @read @description Buffer stats: buffered count, total ever, max capacity */
  async stats() {
    return logStats();
  }
}

registerType('t.logs', Logs);
loadSchemasFromDir(new URL('./schemas', import.meta.url).pathname);
