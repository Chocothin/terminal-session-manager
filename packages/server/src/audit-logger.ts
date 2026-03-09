import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditLogEntry, ServerConfig } from './types.js';

export class AuditLogger {
  private readonly logDir: string;
  private initialized = false;

  constructor(config: ServerConfig) {
    this.logDir = config.logDir;
  }

  async log(entry: AuditLogEntry): Promise<void> {
    if (!this.initialized) {
      await mkdir(this.logDir, { recursive: true });
      this.initialized = true;
    }

    const date = new Date().toISOString().slice(0, 10);
    const filePath = join(this.logDir, `audit-${date}.log`);
    const line = JSON.stringify(entry) + '\n';

    try {
      await appendFile(filePath, line, 'utf-8');
    } catch (err) {
      console.error('[audit] Failed to write audit log:', err instanceof Error ? err.message : err);
    }
  }
}
