import { v4 as uuidv4 } from 'uuid';
import type { SessionInfo, ServerConfig } from './types.js';
import type { PtyManager } from './pty-manager.js';

interface SessionEntry {
  info: SessionInfo;
  clients: Set<string>;
  ttlTimer: ReturnType<typeof setTimeout> | null;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly config: ServerConfig;
  private readonly ptyManager: PtyManager;
  private sessionCounter = 0;

  constructor(config: ServerConfig, ptyManager: PtyManager) {
    this.config = config;
    this.ptyManager = ptyManager;
  }

  createSession(name: string | undefined, cols: number, rows: number, shell: string): SessionInfo {
    const sessionId = uuidv4();
    const sessionName = name || `session-${++this.sessionCounter}`;
    const sanitizedName = sessionName.replace(/[^a-zA-Z0-9\-_.\s]/g, '').slice(0, 64);

    const proc = this.ptyManager.create(sessionId, cols, rows, shell);

    const info: SessionInfo = {
      id: sessionId,
      name: sanitizedName,
      cols,
      rows,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      pid: proc.pid,
      shell,
      writerId: null,
      viewerCount: 0,
    };

    this.sessions.set(sessionId, {
      info,
      clients: new Set(),
      ttlTimer: null,
    });

    return info;
  }

  getSession(sessionId: string): SessionInfo | null {
    const entry = this.sessions.get(sessionId);
    return entry ? entry.info : null;
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((e) => e.info);
  }

  killSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.clearTtlTimer(entry);
    this.ptyManager.kill(sessionId);
    this.sessions.delete(sessionId);
  }

  removeSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.clearTtlTimer(entry);
    this.sessions.delete(sessionId);
  }

  addClient(sessionId: string, clientId: string): void {
    const entry = this.getEntry(sessionId);
    entry.clients.add(clientId);
    entry.info.viewerCount = entry.clients.size;
    entry.info.lastActivity = Date.now();
    this.clearTtlTimer(entry);
  }

  removeClient(sessionId: string, clientId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.clients.delete(clientId);
    entry.info.viewerCount = entry.clients.size;
    entry.info.lastActivity = Date.now();

    if (entry.clients.size === 0) {
      this.startTtlTimer(entry, sessionId);
    }
  }

  getClientsForSession(sessionId: string): string[] {
    const entry = this.sessions.get(sessionId);
    return entry ? Array.from(entry.clients) : [];
  }

  updateWriterId(sessionId: string, writerId: string | null): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.info.writerId = writerId;
    }
  }

  killAll(): void {
    for (const [sessionId] of this.sessions) {
      this.killSession(sessionId);
    }
  }

  private getEntry(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return entry;
  }

  private startTtlTimer(entry: SessionEntry, sessionId: string): void {
    this.clearTtlTimer(entry);
    entry.ttlTimer = setTimeout(() => {
      this.killSession(sessionId);
    }, this.config.sessionTtl);
  }

  private clearTtlTimer(entry: SessionEntry): void {
    if (entry.ttlTimer !== null) {
      clearTimeout(entry.ttlTimer);
      entry.ttlTimer = null;
    }
  }
}
