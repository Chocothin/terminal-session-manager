import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ITermSessionInfo } from './types.js';
import { sanitizeEnv } from './env-sanitizer.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BRIDGE_SCRIPT = resolve(__dirname, 'iterm2_bridge.py');

interface BridgeScreenMessage {
  type: 'screen';
  sessionId: string;
  ansi: string;
  cols: number;
  rows: number;
}

interface BridgeSessionsMessage {
  type: 'sessions' | 'ready';
  sessions: ITermSessionInfo[];
}

interface BridgeErrorMessage {
  type: 'error';
  message: string;
}

interface BridgePongMessage {
  type: 'pong';
}

interface BridgeDetachedMessage {
  type: 'detached';
}

interface BridgeHistoryMessage {
  type: 'history';
  lines: string[];
  hasMore: boolean;
  overflow: number;
  totalScrollback?: number;
}

type BridgeMessage =
  | BridgeScreenMessage
  | BridgeSessionsMessage
  | BridgeErrorMessage
  | BridgePongMessage
  | BridgeDetachedMessage
  | BridgeHistoryMessage;

export class PythonBridge extends EventEmitter {
  private process: ChildProcess | null = null;
  private ready = false;
  private lineBuf = '';
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private readonly maxMissedPongs = 2;
  private readonly healthIntervalMs = 5000;
  private starting = false;
  private destroyed = false;

  async start(): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.process && this.ready) return true;
    if (this.starting) return false;

    this.starting = true;

    const available = await this.checkPythonApi();
    if (!available) {
      this.starting = false;
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const proc = spawn('python3', [BRIDGE_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...sanitizeEnv(), PYTHONUNBUFFERED: '1' },
      });

      const timeout = setTimeout(() => {
        if (!this.ready) {
          proc.kill();
          this.starting = false;
          resolve(false);
        }
      }, 10_000);

      proc.stdout!.on('data', (chunk: Buffer) => {
        this.lineBuf += chunk.toString('utf-8');
        const lines = this.lineBuf.split('\n');
        this.lineBuf = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as BridgeMessage;
            this.handleMessage(msg);

            if (msg.type === 'ready' && !this.ready) {
              this.ready = true;
              clearTimeout(timeout);
              this.starting = false;
              this.startHealthCheck();
              resolve(true);
            }
          } catch {
          }
        }
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8').trim();
        if (text) {
          console.error('[python-bridge:stderr]', text);
        }
      });

      proc.on('exit', (code) => {
        console.error(`[python-bridge] exited with code ${code}`);
        this.cleanup();
        this.starting = false;
        if (!this.ready) {
          clearTimeout(timeout);
          resolve(false);
        }
        this.ready = false;
      });

      proc.on('error', (err) => {
        console.error('[python-bridge] spawn error:', err.message);
        this.cleanup();
        this.starting = false;
        if (!this.ready) {
          clearTimeout(timeout);
          resolve(false);
        }
        this.ready = false;
      });

      this.process = proc;
    });
  }

  isReady(): boolean {
    return this.ready && this.process !== null;
  }

  sendList(): void {
    this.sendCommand({ type: 'list' });
  }

  sendAttach(sessionId: string, cols: number, rows: number): void {
    this.sendCommand({ type: 'attach', sessionId, cols, rows });
  }

  sendDetach(): void {
    this.sendCommand({ type: 'detach' });
  }

  sendInput(data: string): void {
    this.sendCommand({ type: 'input', data });
  }

  sendResize(cols: number, rows: number): void {
    this.sendCommand({ type: 'resize', cols, rows });
  }

  sendGetHistory(lines: number): void {
    this.sendCommand({ type: 'getHistory', lines });
  }

  destroy(): void {
    this.destroyed = true;
    this.cleanup();
  }

  private sendCommand(cmd: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) return;
    const line = JSON.stringify(cmd) + '\n';
    this.process.stdin.write(line);
  }

  private handleMessage(msg: BridgeMessage): void {
    switch (msg.type) {
      case 'screen':
        this.emit('screen', msg.sessionId, msg.ansi, msg.cols, msg.rows);
        break;
      case 'sessions':
      case 'ready':
        this.emit('sessions', msg.sessions);
        break;
      case 'error':
        this.emit('bridge-error', msg.message);
        break;
      case 'pong':
        this.missedPongs = 0;
        break;
      case 'detached':
        this.emit('detached');
        break;
      case 'history':
        this.emit('history', msg.lines, msg.hasMore, msg.overflow, msg.totalScrollback);
        break;
    }
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthTimer = setInterval(() => {
      if (!this.process?.stdin?.writable) {
        this.handleUnhealthy();
        return;
      }

      this.missedPongs++;
      if (this.missedPongs > this.maxMissedPongs) {
        this.handleUnhealthy();
        return;
      }

      this.sendCommand({ type: 'ping' });
    }, this.healthIntervalMs);
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private handleUnhealthy(): void {
    console.error('[python-bridge] unhealthy — restarting');
    this.cleanup();
    this.ready = false;

    if (!this.destroyed) {
      setTimeout(() => this.start().catch(() => {}), 1000);
    }
  }

  private cleanup(): void {
    this.stopHealthCheck();
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
    this.lineBuf = '';
    this.missedPongs = 0;
  }

  private async checkPythonApi(): Promise<boolean> {
    try {
      await execFileAsync('python3', ['-c', 'import iterm2'], { timeout: 5000 });
      return true;
    } catch {
      console.error('[python-bridge] iterm2 Python package not available');
      return false;
    }
  }
}
