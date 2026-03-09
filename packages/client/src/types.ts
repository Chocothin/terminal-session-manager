export type PermissionRole = 'viewer' | 'writer';

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

export interface ITermSessionInfo {
  id: string;
  name: string;
  tty: string;
  cols: number;
  rows: number;
}

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
  | { type: 'iterm.list' }
  | { type: 'iterm.attach'; itermSessionId: string; cols?: number; rows?: number }
  | { type: 'iterm.detach' }
  | { type: 'iterm.input'; data: string }
  | { type: 'iterm.resize'; cols: number; rows: number }
  | { type: 'iterm.getHistory'; lines?: number }
  | { type: 'iterm.create' }
  | { type: 'iterm.kill'; itermSessionId: string }
  | { type: 'ping' };

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
  | { type: 'iterm.list'; sessions: ITermSessionInfo[] }
  | { type: 'iterm.attached'; session: ITermSessionInfo; content: string }
  | { type: 'iterm.output'; data: string; cols?: number; rows?: number }
  | { type: 'iterm.detached' }
  | { type: 'iterm.error'; message: string }
  | { type: 'iterm.unavailable' }
  | { type: 'iterm.history'; lines: string[]; hasMore: boolean; overflow: number; totalScrollback?: number }
  | { type: 'iterm.created'; session: ITermSessionInfo }
  | { type: 'iterm.killed'; itermSessionId: string }
  | { type: 'pong' }
  | { type: 'error'; message: string };

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface AppState {
  connection: ConnectionState;
  clientId: string | null;
  currentSession: SessionInfo | null;
  role: PermissionRole | null;
  sessions: SessionInfo[];
  itermSession: ITermSessionInfo | null;
  itermSessions: ITermSessionInfo[];
}
