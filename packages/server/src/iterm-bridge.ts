import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Defence-in-depth: escape a string for safe interpolation into AppleScript double-quoted strings. */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface ITermSessionInfo {
  id: string;
  name: string;
  tty: string;
  cols: number;
  rows: number;
}

interface MonitorEntry {
  itermSessionId: string;
  lastContent: string;
  interval: ReturnType<typeof setInterval>;
  listeners: Array<(lines: string[], cols: number, rows: number) => void>;
}

export class ITermBridge {
  private monitors = new Map<string, MonitorEntry>();
  private available: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('osascript', ['-e',
        'tell application "System Events" to return (name of processes) contains "iTerm2"'
      ], { timeout: 3000 });
      this.available = stdout.trim() === 'true';
      return this.available;
    } catch {
      this.available = false;
      return false;
    }
  }

  async createSession(): Promise<ITermSessionInfo | null> {
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', `
tell application "iTerm2"
  activate
  set w to (current window)
  if w is missing value then
    set w to (create window with default profile)
    set s to current session of (current tab of w)
  else
    set t to (create tab with default profile in w)
    set s to current session of t
  end if
  return (unique id of s) & "||" & (name of s) & "||" & (tty of s) & "||" & (columns of s) & "||" & (rows of s)
end tell
      `], { timeout: 10000 });

      const parts = stdout.trim().split('||');
      const id = parts[0] ?? '';
      if (!id) return null;

      return {
        id,
        name: parts[1] ?? 'New Session',
        tty: parts[2] ?? '',
        cols: parseInt(parts[3] ?? '80', 10),
        rows: parseInt(parts[4] ?? '24', 10),
      };
    } catch (err) {
      console.error('[iterm-bridge] createSession failed:', err);
      return null;
    }
  }

  async listSessions(): Promise<ITermSessionInfo[]> {
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', `
tell application "iTerm2"
  set sessionList to {}
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        set end of sessionList to (unique id of s) & "||" & (name of s) & "||" & (tty of s) & "||" & (columns of s) & "||" & (rows of s)
      end repeat
    end repeat
  end repeat
  return sessionList
end tell
      `], { timeout: 5000 });

      return stdout.trim().split(', ').filter(Boolean).map(entry => {
        const parts = entry.split('||');
        return {
          id: parts[0] ?? '',
          name: parts[1] ?? '',
          tty: parts[2] ?? '',
          cols: parseInt(parts[3] ?? '80', 10),
          rows: parseInt(parts[4] ?? '24', 10),
        };
      }).filter(s => s.id.length > 0);
    } catch {
      return [];
    }
  }

  startMonitoring(
    itermSessionId: string,
    listener: (lines: string[], cols: number, rows: number) => void,
  ): void {
    const existing = this.monitors.get(itermSessionId);
    if (existing) {
      existing.listeners.push(listener);
      return;
    }

    const entry: MonitorEntry = {
      itermSessionId,
      lastContent: '',
      interval: setInterval(() => this.pollContent(itermSessionId), 150),
      listeners: [listener],
    };

    this.monitors.set(itermSessionId, entry);
  }

  stopMonitoring(
    itermSessionId: string,
    listener: (lines: string[], cols: number, rows: number) => void,
  ): void {
    const entry = this.monitors.get(itermSessionId);
    if (!entry) return;

    entry.listeners = entry.listeners.filter(l => l !== listener);
    if (entry.listeners.length === 0) {
      clearInterval(entry.interval);
      this.monitors.delete(itermSessionId);
    }
  }

  async sendInput(itermSessionId: string, data: string): Promise<void> {
    const script = this.buildInputScript(itermSessionId, data);
    try {
      await execFileAsync('osascript', ['-e', script], { timeout: 3000 });
    } catch {
      // intentionally swallowed
    }
  }

  private buildInputScript(sessionId: string, data: string): string {
    const charStatements: string[] = [];
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);
      if (code < 32 || code === 127) {
        charStatements.push(`(ASCII character ${code})`);
      } else if (code === 92) {
        charStatements.push(`"\\\\""`);
      } else if (code === 34) {
        charStatements.push(`"\\"""`);
      } else {
        charStatements.push(`"${data[i]}"`);
      }
    }

    const textExpr = charStatements.length === 1
      ? charStatements[0]!
      : charStatements.join(' & ');

    return `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if unique id of s is "${escapeAppleScript(sessionId)}" then
          tell s to write text (${textExpr}) newline no
          return
        end if
      end repeat
    end repeat
  end repeat
end tell`;
  }

  async getContent(itermSessionId: string): Promise<{ content: string; cols: number; rows: number } | null> {
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if unique id of s is "${escapeAppleScript(itermSessionId)}" then
          return (contents of s) & "||DELIM||" & (columns of s) & "||DELIM||" & (rows of s)
        end if
      end repeat
    end repeat
  end repeat
end tell
      `], { timeout: 5000 });

      const parts = stdout.split('||DELIM||');
      return {
        content: parts[0] ?? '',
        cols: parseInt(parts[1] ?? '80', 10),
        rows: parseInt(parts[2] ?? '24', 10),
      };
    } catch {
      return null;
    }
  }

  async closeSession(itermSessionId: string): Promise<boolean> {
    const entry = this.monitors.get(itermSessionId);
    if (entry) {
      clearInterval(entry.interval);
      this.monitors.delete(itermSessionId);
    }
    try {
      const escaped = escapeAppleScript(itermSessionId);
      await execFileAsync('osascript', ['-e', `
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if unique id of s is "${escaped}" then
          close s
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell
      `], { timeout: 5000 });
      return true;
    } catch (err) {
      console.error('[iterm-bridge] closeSession failed:', err);
      return false;
    }
  }

  destroy(): void {
    for (const entry of this.monitors.values()) {
      clearInterval(entry.interval);
    }
    this.monitors.clear();
  }

  private async pollContent(itermSessionId: string): Promise<void> {
    const entry = this.monitors.get(itermSessionId);
    if (!entry) return;

    const result = await this.getContent(itermSessionId);
    if (!result) return;

    const { content, cols, rows } = result;

    if (content === entry.lastContent) return;

    const oldLines = entry.lastContent.split('\n');
    const newLines = content.split('\n');
    entry.lastContent = content;

    let changedCount = 0;
    for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
      if (i >= oldLines.length || i >= newLines.length || newLines[i] !== oldLines[i]) {
        changedCount++;
      }
    }

    const changes: string[] = [];

    if (changedCount > rows * 0.6) {
      changes.push(`\x1b[2J\x1b[H${newLines.join('\r\n')}`);
    } else {
      for (let i = 0; i < newLines.length; i++) {
        if (i >= oldLines.length || newLines[i] !== oldLines[i]) {
          changes.push(`\x1b[${i + 1};1H${newLines[i]}\x1b[K`);
        }
      }
      for (let i = newLines.length; i < oldLines.length; i++) {
        changes.push(`\x1b[${i + 1};1H\x1b[K`);
      }
    }

    if (changes.length > 0) {
      for (const listener of entry.listeners) {
        listener(changes, cols, rows);
      }
    }
  }
}
