// ─── Session ────────────────────────────────────────────────────────────────

export interface SessionInfo {
  id: string;
  name: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivity: number;
  pid: number;
  shell: string;
  writerId: string | null;
  viewerCount: number;
}

// ─── Permission ─────────────────────────────────────────────────────────────

export type PermissionRole = 'viewer' | 'writer';

export interface ClientInfo {
  id: string;
  role: PermissionRole;
  connectedAt: number;
  sessionId: string;
  remoteAddress: string;
}

// ─── Protocol Messages (Client → Server) ────────────────────────────────────

export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'session.create'; name?: string; cols?: number; rows?: number }
  | { type: 'session.list' }
  | { type: 'session.attach'; sessionId: string }
  | { type: 'session.detach' }
  | { type: 'session.kill'; sessionId: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'permission.takeover' }
  | { type: 'permission.release' }
  | { type: 'ping' }
  | { type: 'iterm.list' }
  | { type: 'iterm.attach'; itermSessionId: string; cols?: number; rows?: number }
  | { type: 'iterm.detach' }
  | { type: 'iterm.input'; data: string }
  | { type: 'iterm.resize'; cols: number; rows: number }
  | { type: 'iterm.getHistory'; lines?: number }
  | { type: 'iterm.create' }
  | { type: 'iterm.kill'; itermSessionId: string };

// ─── Protocol Messages (Server → Client) ────────────────────────────────────

export type ServerMessage =
  | { type: 'auth.success'; clientId: string }
  | { type: 'auth.error'; message: string }
  | { type: 'session.created'; session: SessionInfo }
  | { type: 'session.list'; sessions: SessionInfo[] }
  | { type: 'session.attached'; session: SessionInfo; role: PermissionRole; buffer: string }
  | { type: 'session.detached' }
  | { type: 'session.killed'; sessionId: string }
  | { type: 'session.ended'; sessionId: string; exitCode: number; signal?: number }
  | { type: 'output'; data: string }
  | { type: 'permission.changed'; role: PermissionRole; writerId: string | null }
  | { type: 'permission.denied'; reason: string }
  | { type: 'client.joined'; clientId: string; role: PermissionRole; viewerCount: number }
  | { type: 'client.left'; clientId: string; viewerCount: number }
  | { type: 'pong' }
  | { type: 'error'; message: string }
  | { type: 'iterm.list'; sessions: ITermSessionInfo[] }
  | { type: 'iterm.attached'; session: ITermSessionInfo; content: string }
  | { type: 'iterm.output'; data: string; cols?: number; rows?: number }
  | { type: 'iterm.detached' }
  | { type: 'iterm.error'; message: string }
  | { type: 'iterm.unavailable' }
  | { type: 'iterm.history'; lines: string[]; hasMore: boolean; overflow: number; totalScrollback?: number }
  | { type: 'iterm.created'; session: ITermSessionInfo }
  | { type: 'iterm.killed'; itermSessionId: string };

// ─── Audit Log ──────────────────────────────────────────────────────────────

export type AuditEventType =
  | 'session.create'
  | 'session.attach'
  | 'session.detach'
  | 'session.kill'
  | 'session.ended'
  | 'permission.takeover'
  | 'permission.release'
  | 'auth.success'
  | 'auth.failure'
  | 'client.connect'
  | 'client.disconnect'
  | 'input.write'
  | 'iterm.attach'
  | 'iterm.detach'
  | 'iterm.create'
  | 'iterm.kill';

export interface AuditLogEntry {
  timestamp: string;
  eventType: AuditEventType;
  clientId: string;
  sessionId: string | null;
  remoteAddress: string;
  details: Record<string, unknown>;
}

// ─── iTerm2 Session Sync ─────────────────────────────────────────────────────

export interface ITermSessionInfo {
  id: string;
  name: string;
  tty: string;
  cols: number;
  rows: number;
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface ServerConfig {
  port: number;
  host: string;
  authToken: string;
  sessionTtl: number;       // ms to keep orphaned sessions alive (default: 5min)
  heartbeatInterval: number; // ms between heartbeats (default: 30s)
  heartbeatTimeout: number;  // ms before declaring dead (default: 45s)
  maxBufferSize: number;     // bytes to buffer for reconnection (default: 256KB)
  maxSessionsPerClient: number;
  allowedOrigins: string[];
  logDir: string;
  shell: string;
}
