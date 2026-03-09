import * as pty from 'node-pty';
import type { ServerConfig } from './types.js';
import { sanitizeEnv } from './env-sanitizer.js';

interface PtyEntry {
  process: pty.IPty;
  buffer: string;
  dataListeners: Array<(data: string) => void>;
  exitListeners: Array<(exitCode: number, signal?: number) => void>;
  disposed: boolean;
}

export class PtyManager {
  private readonly entries = new Map<string, PtyEntry>();
  private readonly maxBufferSize: number;

  constructor(config: ServerConfig) {
    this.maxBufferSize = config.maxBufferSize;
  }

  create(sessionId: string, cols: number, rows: number, shell: string): pty.IPty {
    if (this.entries.has(sessionId)) {
      throw new Error(`PTY already exists for session ${sessionId}`);
    }

    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env['HOME'] || process.cwd(),
      env: sanitizeEnv(),
    });

    const entry: PtyEntry = {
      process: proc,
      buffer: '',
      dataListeners: [],
      exitListeners: [],
      disposed: false,
    };

    proc.onData((data: string) => {
      if (entry.disposed) return;
      this.appendBuffer(entry, data);
      for (const listener of entry.dataListeners) {
        listener(data);
      }
    });

    proc.onExit(({ exitCode, signal }) => {
      if (entry.disposed) return;
      entry.disposed = true;
      for (const listener of entry.exitListeners) {
        listener(exitCode, signal);
      }
      this.entries.delete(sessionId);
    });

    this.entries.set(sessionId, entry);
    return proc;
  }

  write(sessionId: string, data: string): void {
    const entry = this.getEntry(sessionId);
    entry.process.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.getEntry(sessionId);
    entry.process.resize(cols, rows);
  }

  kill(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.disposed = true;
    entry.process.kill();
    this.entries.delete(sessionId);
  }

  getBuffer(sessionId: string): string {
    const entry = this.entries.get(sessionId);
    return entry ? entry.buffer : '';
  }

  onData(sessionId: string, callback: (data: string) => void): void {
    const entry = this.getEntry(sessionId);
    entry.dataListeners.push(callback);
  }

  onExit(sessionId: string, callback: (exitCode: number, signal?: number) => void): void {
    const entry = this.getEntry(sessionId);
    entry.exitListeners.push(callback);
  }

  killAll(): void {
    for (const [sessionId] of this.entries) {
      this.kill(sessionId);
    }
  }

  private getEntry(sessionId: string): PtyEntry {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      throw new Error(`No PTY for session ${sessionId}`);
    }
    return entry;
  }

  private appendBuffer(entry: PtyEntry, data: string): void {
    entry.buffer += data;
    // Ring buffer: trim from the front when exceeding max size
    if (entry.buffer.length > this.maxBufferSize) {
      entry.buffer = entry.buffer.slice(entry.buffer.length - this.maxBufferSize);
    }
  }
}
