// t.logs — unified log buffer, queryable via actions + MCP

import { registerType } from '#comp';
import { interceptConsole, logStats, queryLogs, type LogLevel } from '#log';

interceptConsole();

/** @description Server log buffer — query, grep, filter by level */
export class Logs {
  /** @description Query log buffer with grep, level filter, head/tail */
  async query(data: {
    /** Regex pattern to filter messages */ grep?: string;
    /** Log level(s) to include */ level?: LogLevel | LogLevel[];
    /** Return first N entries */ head?: number;
    /** Return last N entries */ tail?: number;
  }) {
    return queryLogs(data);
  }

  /** @description Buffer stats: buffered count, total ever, max capacity */
  async stats() {
    return logStats();
  }
}

registerType('t.logs', Logs);
