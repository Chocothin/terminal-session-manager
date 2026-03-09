import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import type {
  ClientMessage,
  ServerMessage,
  ServerConfig,
  AuditEventType,
} from './types.js';
import type { SessionManager } from './session-manager.js';
import type { PtyManager } from './pty-manager.js';
import type { PermissionController } from './permission.js';
import type { AuditLogger } from './audit-logger.js';
import { RateLimiter } from './rate-limiter.js';
import { validateClientMessage } from './validate.js';
import { ITermBridge } from './iterm-bridge.js';
import { PythonBridge } from './python-bridge.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json',
};

interface ClientState {
  id: string;
  ws: WebSocket;
  authenticated: boolean;
  sessionId: string | null;
  itermSessionId: string | null;
  remoteAddress: string;
  alive: boolean;
}

export class WsServer {
  private readonly httpServer: Server;
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<string, ClientState>();
  private readonly sessionManager: SessionManager;
  private readonly ptyManager: PtyManager;
  private readonly permissions: PermissionController;
  private readonly auditLogger: AuditLogger;
  private readonly config: ServerConfig;
  private readonly staticDir: string | null;
  private readonly maxConnections = 50;
  private readonly maxConnectionsPerIp = 10;
  private readonly authLimiter = new RateLimiter({ windowMs: 60_000, maxAttempts: 5 });
  private readonly itermBridge = new ITermBridge();
  private readonly pythonBridge = new PythonBridge();
  private usePythonBridge = false;
  private pythonBridgeLastStartAttempt = 0;
  private readonly pythonBridgeRetryIntervalMs = 5000;
  private readonly itermListeners = new Map<string, (changes: string[], cols: number, rows: number) => void>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    sessionManager: SessionManager,
    ptyManager: PtyManager,
    permissions: PermissionController,
    auditLogger: AuditLogger,
    config: ServerConfig,
  ) {
    this.sessionManager = sessionManager;
    this.ptyManager = ptyManager;
    this.permissions = permissions;
    this.auditLogger = auditLogger;
    this.config = config;

    const clientDist = resolve(import.meta.dirname ?? '.', '../../client/dist');
    this.staticDir = existsSync(join(clientDist, 'index.html')) ? clientDist : null;

    if (this.staticDir) {
      console.log(`[ws-server] Serving static files from ${this.staticDir}`);
    }

    this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res));

    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: 64 * 1024,
      verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) => {
        if (this.config.allowedOrigins.length === 0) return true;
        const origin = info.origin || '';
        return this.config.allowedOrigins.includes(origin);
      },
    });

    this.httpServer.listen(config.port, config.host);

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.startHeartbeat();
    this.initPythonBridge();
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    // Health endpoint (no auth required)
    const reqUrl = req.url?.split('?')[0];
    if (reqUrl === '/health') {
      const body = JSON.stringify({
        status: 'ok',
        timestamp: Date.now(),
        uptime: process.uptime(),
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (!this.staticDir) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('TSM WebSocket Server');
      return;
    }

    let urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (urlPath === '/') urlPath = '/index.html';

    const filePath = resolve(this.staticDir, '.' + urlPath);

    if (!filePath.startsWith(this.staticDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error('Not a file');

      const ext = extname(filePath);
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': urlPath === '/index.html' || urlPath === '/sw.js'
          ? 'no-cache'
          : 'public, max-age=31536000, immutable',
      });
      createReadStream(filePath).pipe(res);
    } catch {
      const indexPath = join(this.staticDir, 'index.html');
      try {
        const stat = statSync(indexPath);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache',
        });
        createReadStream(indexPath).pipe(res);
      } catch {
        res.writeHead(404);
        res.end('Not Found');
      }
    }
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.authLimiter.destroy();
    this.itermBridge.destroy();
    this.pythonBridge.destroy();
    for (const client of this.clients.values()) {
      client.ws.close(1001, 'Server shutting down');
    }
    this.wss.close();
    this.httpServer.close();
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Global connection limit
    if (this.clients.size >= this.maxConnections) {
      ws.close(4429, 'Too many connections');
      return;
    }
    // Per-IP connection limit
    const remoteAddress = req.socket.remoteAddress || 'unknown';
    let ipConnectionCount = 0;
    for (const c of this.clients.values()) {
      if (c.remoteAddress === remoteAddress) ipConnectionCount++;
    }
    if (ipConnectionCount >= this.maxConnectionsPerIp) {
      ws.close(4429, 'Too many connections from this IP');
      return;
    }

    const clientId = uuidv4();

    const client: ClientState = {
      id: clientId,
      ws,
      authenticated: false,
      sessionId: null,
      itermSessionId: null,
      remoteAddress,
      alive: true,
    };

    this.clients.set(clientId, client);

    this.audit('client.connect', clientId, null, remoteAddress, {});

    const authTimeout = setTimeout(() => {
      if (!client.authenticated) {
        this.send(ws, { type: 'auth.error', message: 'Authentication timeout' });
        ws.close(4001, 'Auth timeout');
      }
    }, 5000);

    ws.on('message', (raw) => {
      client.alive = true;
      let msg: ClientMessage;
      try {
        const parsed: unknown = JSON.parse(raw.toString());
        const validated = validateClientMessage(parsed);
        if (!validated) {
          this.send(ws, { type: 'error', message: 'Invalid message format' });
          return;
        }
        msg = validated;
      } catch {
        this.send(ws, { type: 'error', message: 'Invalid JSON' });
        return;
      }

      if (!client.authenticated) {
        if (msg.type === 'auth') {
          clearTimeout(authTimeout);
          this.handleAuth(client, msg.token);
        } else {
          this.send(ws, { type: 'error', message: 'Not authenticated' });
        }
        return;
      }

      this.handleMessage(client, msg);
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      this.handleDisconnect(client);
    });

    ws.on('pong', () => {
      client.alive = true;
    });
  }

  private handleAuth(client: ClientState, token: string): void {
    if (this.authLimiter.isBlocked(client.remoteAddress)) {
      this.send(client.ws, { type: 'auth.error', message: 'Too many attempts. Try again later.' });
      this.audit('auth.failure', client.id, null, client.remoteAddress, { reason: 'rate_limited' });
      client.ws.close(4429, 'Rate limited');
      return;
    }

    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(this.config.authToken);
    const isValid = tokenBuf.length === expectedBuf.length && timingSafeEqual(tokenBuf, expectedBuf);
    if (!isValid) {
      this.authLimiter.attempt(client.remoteAddress);
      this.send(client.ws, { type: 'auth.error', message: 'Invalid token' });
      this.audit('auth.failure', client.id, null, client.remoteAddress, {});
      client.ws.close(4003, 'Invalid token');
      return;
    }

    client.authenticated = true;
    this.send(client.ws, { type: 'auth.success', clientId: client.id });
    this.audit('auth.success', client.id, null, client.remoteAddress, {});
  }

  private handleMessage(client: ClientState, msg: ClientMessage): void {
    switch (msg.type) {
      case 'auth':
        this.send(client.ws, { type: 'error', message: 'Already authenticated' });
        break;
      case 'session.create':
        this.handleSessionCreate(client, msg.name, msg.cols, msg.rows);
        break;
      case 'session.list':
        this.handleSessionList(client);
        break;
      case 'session.attach':
        this.handleSessionAttach(client, msg.sessionId);
        break;
      case 'session.detach':
        this.handleSessionDetach(client);
        break;
      case 'session.kill':
        this.handleSessionKill(client, msg.sessionId);
        break;
      case 'input':
        this.handleInput(client, msg.data);
        break;
      case 'resize':
        this.handleResize(client, msg.cols, msg.rows);
        break;
      case 'permission.takeover':
        this.handleTakeover(client);
        break;
      case 'permission.release':
        this.handleRelease(client);
        break;
      case 'ping':
        this.send(client.ws, { type: 'pong' });
        break;
      case 'iterm.list':
        this.handleITermList(client);
        break;
      case 'iterm.create':
        this.handleITermCreate(client);
        break;
      case 'iterm.attach':
        this.handleITermAttach(client, msg.itermSessionId, msg.cols, msg.rows);
        break;
      case 'iterm.detach':
        this.handleITermDetach(client);
        break;
      case 'iterm.input':
        this.handleITermInput(client, msg.data);
        break;
      case 'iterm.resize':
        this.handleITermResize(client, msg.cols, msg.rows);
        break;
      case 'iterm.getHistory':
        this.handleITermGetHistory(client, msg.lines);
        break;
      case 'iterm.kill':
        this.handleITermKill(client, msg.itermSessionId);
        break;
    }
  }

  private handleSessionCreate(
    client: ClientState,
    name: string | undefined,
    cols: number | undefined,
    rows: number | undefined,
  ): void {
    let clientSessionCount = 0;
    for (const session of this.sessionManager.listSessions()) {
      if (session.writerId === client.id) clientSessionCount++;
    }
    if (clientSessionCount >= this.config.maxSessionsPerClient) {
      this.send(client.ws, { type: 'error', message: 'Maximum sessions per client exceeded' });
      return;
    }

    try {
      const session = this.sessionManager.createSession(
        name,
        cols ?? 80,
        rows ?? 24,
        this.config.shell,
      );

      this.permissions.initSession(session.id);

      this.ptyManager.onExit(session.id, (exitCode, signal) => {
        this.broadcastToSession(session.id, {
          type: 'session.ended',
          sessionId: session.id,
          exitCode,
          signal,
        });
        this.audit('session.ended', client.id, session.id, client.remoteAddress, {
          exitCode,
          signal,
        });
        this.permissions.removeSession(session.id);
        this.sessionManager.removeSession(session.id);
      });

      this.send(client.ws, { type: 'session.created', session });
      this.audit('session.create', client.id, session.id, client.remoteAddress, {
        name: session.name,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create session';
      this.send(client.ws, { type: 'error', message });
    }
  }

  private handleSessionList(client: ClientState): void {
    const sessions = this.sessionManager.listSessions();
    this.send(client.ws, { type: 'session.list', sessions });
  }

  private handleSessionAttach(client: ClientState, sessionId: string): void {
    if (client.sessionId) {
      this.detachClient(client);
    }

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      this.send(client.ws, { type: 'error', message: `Session not found: ${sessionId}` });
      return;
    }

    client.sessionId = sessionId;
    this.sessionManager.addClient(sessionId, client.id);

    const role = this.permissions.getRole(sessionId, client.id);
    const buffer = this.ptyManager.getBuffer(sessionId);

    this.ptyManager.onData(sessionId, (data) => {
      if (client.sessionId === sessionId && client.ws.readyState === WebSocket.OPEN) {
        this.send(client.ws, { type: 'output', data });
      }
    });

    const updatedSession = this.sessionManager.getSession(sessionId);
    this.send(client.ws, {
      type: 'session.attached',
      session: updatedSession!,
      role,
      buffer,
    });

    this.broadcastToSession(sessionId, {
      type: 'client.joined',
      clientId: client.id,
      role,
      viewerCount: updatedSession!.viewerCount,
    }, client.id);

    this.audit('session.attach', client.id, sessionId, client.remoteAddress, { role });
  }

  private handleSessionDetach(client: ClientState): void {
    if (!client.sessionId) {
      this.send(client.ws, { type: 'error', message: 'Not attached to any session' });
      return;
    }
    this.detachClient(client);
    this.send(client.ws, { type: 'session.detached' });
  }

  private handleSessionKill(client: ClientState, sessionId: string): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      this.send(client.ws, { type: 'error', message: `Session not found: ${sessionId}` });
      return;
    }

    this.broadcastToSession(sessionId, { type: 'session.killed', sessionId });
    this.send(client.ws, { type: 'session.killed', sessionId });
    this.permissions.removeSession(sessionId);
    this.sessionManager.killSession(sessionId);
    this.audit('session.kill', client.id, sessionId, client.remoteAddress, {});
  }

  private handleInput(client: ClientState, data: string): void {
    if (!client.sessionId) {
      this.send(client.ws, { type: 'error', message: 'Not attached to any session' });
      return;
    }

    const role = this.permissions.getRole(client.sessionId, client.id);
    if (role !== 'writer') {
      this.send(client.ws, {
        type: 'permission.denied',
        reason: 'Only the writer can send input',
      });
      return;
    }

    try {
      this.ptyManager.write(client.sessionId, data);
      this.audit('input.write', client.id, client.sessionId, client.remoteAddress, { bytes: data.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Write failed';
      this.send(client.ws, { type: 'error', message });
    }
  }

  private handleResize(client: ClientState, cols: number, rows: number): void {
    if (!client.sessionId) {
      this.send(client.ws, { type: 'error', message: 'Not attached to any session' });
      return;
    }

    const role = this.permissions.getRole(client.sessionId, client.id);
    if (role !== 'writer') {
      this.send(client.ws, {
        type: 'permission.denied',
        reason: 'Only the writer can resize',
      });
      return;
    }

    try {
      this.ptyManager.resize(client.sessionId, cols, rows);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Resize failed';
      this.send(client.ws, { type: 'error', message });
    }
  }

  private handleTakeover(client: ClientState): void {
    if (!client.sessionId) {
      this.send(client.ws, { type: 'error', message: 'Not attached to any session' });
      return;
    }

    const result = this.permissions.takeover(client.sessionId, client.id);
    if (!result.granted) {
      this.send(client.ws, { type: 'permission.denied', reason: result.reason });
      return;
    }

    this.sessionManager.updateWriterId(client.sessionId, client.id);

    for (const [, c] of this.clients) {
      if (c.sessionId !== client.sessionId || !c.authenticated) continue;
      this.send(c.ws, {
        type: 'permission.changed',
        role: c.id === client.id ? 'writer' : 'viewer',
        writerId: client.id,
      });
    }

    this.audit('permission.takeover', client.id, client.sessionId, client.remoteAddress, {});
  }

  private handleRelease(client: ClientState): void {
    if (!client.sessionId) {
      this.send(client.ws, { type: 'error', message: 'Not attached to any session' });
      return;
    }

    const event = this.permissions.release(client.sessionId, client.id);
    if (!event) {
      this.send(client.ws, { type: 'error', message: 'You are not the writer' });
      return;
    }

    this.sessionManager.updateWriterId(client.sessionId, null);
    this.broadcastToSession(client.sessionId, {
      type: 'permission.changed',
      role: 'viewer',
      writerId: null,
    });
    this.audit('permission.release', client.id, client.sessionId, client.remoteAddress, {});
  }

  private initPythonBridge(): void {
    this.pythonBridge.start().then((ok) => {
      this.usePythonBridge = ok;
      if (ok) {
        console.log('[ws-server] Python bridge active — using iTerm2 Python API');
      } else {
        console.log('[ws-server] Python bridge unavailable — falling back to AppleScript');
      }
    }).catch(() => {
      this.usePythonBridge = false;
    });

    this.pythonBridge.on('screen', (sessionId: string, ansi: string, cols: number, rows: number) => {
      const filtered = this.filterDsrResponses(ansi);
      for (const client of this.clients.values()) {
        if (client.itermSessionId === sessionId && client.ws.readyState === WebSocket.OPEN) {
          this.send(client.ws, { type: 'iterm.output', data: filtered, cols, rows });
        }
      }
    });

    this.pythonBridge.on('sessions', (sessions: import('./types.js').ITermSessionInfo[]) => {
      for (const client of this.clients.values()) {
        if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
          this.send(client.ws, { type: 'iterm.list', sessions });
        }
      }
    });

    this.pythonBridge.on('bridge-error', (message: string) => {
      console.error('[python-bridge]', message);
    });

    this.pythonBridge.on('history', (lines: string[], hasMore: boolean, overflow: number, totalScrollback?: number) => {
      for (const client of this.clients.values()) {
        if (client.itermSessionId && client.ws.readyState === WebSocket.OPEN) {
          this.send(client.ws, { type: 'iterm.history', lines, hasMore, overflow, totalScrollback });
        }
      }
    });
  }

  private async ensurePythonBridgeReady(): Promise<boolean> {
    if (this.pythonBridge.isReady()) {
      this.usePythonBridge = true;
      return true;
    }

    const now = Date.now();
    if (now - this.pythonBridgeLastStartAttempt < this.pythonBridgeRetryIntervalMs) {
      return false;
    }

    this.pythonBridgeLastStartAttempt = now;
    const ok = await this.pythonBridge.start().catch(() => false);
    this.usePythonBridge = ok && this.pythonBridge.isReady();

    if (this.usePythonBridge) {
      console.log('[ws-server] Python bridge recovered — using iTerm2 Python API');
    }

    return this.usePythonBridge;
  }

  private filterDsrResponses(input: string): string {
    return input
      .replace(/\x1b\[\d+;\d+R/g, '')
      .replace(/\x1b\[\?\d+[;\d]*c/g, '')
      .replace(/\x1b\[>\d+[;\d]*c/g, '')
      .replace(/\x1b\[\d+n/g, '');
  }

  private async handleITermCreate(client: ClientState): Promise<void> {
    const available = await this.itermBridge.isAvailable();
    if (!available) {
      this.send(client.ws, { type: 'iterm.error', message: 'iTerm2 is not running' });
      return;
    }

    const session = await this.itermBridge.createSession();
    if (!session) {
      this.send(client.ws, { type: 'iterm.error', message: 'Failed to create iTerm2 session' });
      return;
    }

    this.send(client.ws, { type: 'iterm.created', session });

    this.audit('iterm.create', client.id, null, client.remoteAddress, {
      itermSessionId: session.id,
      name: session.name,
    });

    const sessions = await this.itermBridge.listSessions();
    for (const c of this.clients.values()) {
      if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
        this.send(c.ws, { type: 'iterm.list', sessions });
      }
    }
  }

  private async handleITermKill(client: ClientState, itermSessionId: string): Promise<void> {
    for (const c of this.clients.values()) {
      if (c.itermSessionId === itermSessionId) {
        c.itermSessionId = null;
        this.send(c.ws, { type: 'iterm.killed', itermSessionId });
      }
    }
    if (client.itermSessionId !== itermSessionId) {
      this.send(client.ws, { type: 'iterm.killed', itermSessionId });
    }

    await this.itermBridge.closeSession(itermSessionId);
    this.audit('iterm.kill', client.id, null, client.remoteAddress, { itermSessionId });

    const sessions = await this.itermBridge.listSessions();
    for (const c of this.clients.values()) {
      if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
        this.send(c.ws, { type: 'iterm.list', sessions });
      }
    }
  }

  private async handleITermList(client: ClientState): Promise<void> {
    if (await this.ensurePythonBridgeReady()) {
      this.pythonBridge.sendList();
      return;
    }

    const available = await this.itermBridge.isAvailable();
    if (!available) {
      this.send(client.ws, { type: 'iterm.unavailable' });
      return;
    }
    const sessions = await this.itermBridge.listSessions();
    this.send(client.ws, { type: 'iterm.list', sessions });
  }

  private async handleITermAttach(
    client: ClientState,
    itermSessionId: string,
    cols?: number,
    rows?: number,
  ): Promise<void> {
    if (client.sessionId) {
      this.detachClient(client);
    }
    if (client.itermSessionId) {
      this.doITermDetach(client);
    }

    const attachCols = cols ?? 80;
    const attachRows = rows ?? 24;

    if (await this.ensurePythonBridgeReady()) {
      client.itermSessionId = itermSessionId;

      const sessions = await this.itermBridge.listSessions().catch(() => []);
      const sessionInfo = sessions.find(s => s.id === itermSessionId) ?? {
        id: itermSessionId,
        name: 'iTerm2 Session',
        tty: '',
        cols: 120,
        rows: 40,
      };

      this.send(client.ws, {
        type: 'iterm.attached',
        session: sessionInfo,
        content: '',
      });

      this.pythonBridge.sendAttach(itermSessionId, attachCols, attachRows);

      this.audit('iterm.attach', client.id, null, client.remoteAddress, {
        itermSessionId,
        name: sessionInfo.name,
        bridge: 'python',
      });
      return;
    }

    const available = await this.itermBridge.isAvailable();
    if (!available) {
      this.send(client.ws, { type: 'iterm.error', message: 'iTerm2 is not running' });
      return;
    }

    const result = await this.itermBridge.getContent(itermSessionId);
    if (!result) {
      this.send(client.ws, { type: 'iterm.error', message: 'iTerm2 session not found' });
      return;
    }

    const sessions = await this.itermBridge.listSessions();
    const sessionInfo = sessions.find(s => s.id === itermSessionId);
    if (!sessionInfo) {
      this.send(client.ws, { type: 'iterm.error', message: 'iTerm2 session not found' });
      return;
    }

    client.itermSessionId = itermSessionId;

    const listener = (changes: string[], _cols: number, _rows: number): void => {
      if (client.ws.readyState === WebSocket.OPEN && client.itermSessionId === itermSessionId) {
        this.send(client.ws, { type: 'iterm.output', data: changes.join('') });
      }
    };

    this.itermListeners.set(client.id, listener);
    this.itermBridge.startMonitoring(itermSessionId, listener);

    this.send(client.ws, {
      type: 'iterm.attached',
      session: sessionInfo,
      content: result.content,
    });

    this.audit('iterm.attach', client.id, null, client.remoteAddress, {
      itermSessionId,
      name: sessionInfo.name,
      bridge: 'applescript',
    });
  }

  private handleITermDetach(client: ClientState): void {
    if (!client.itermSessionId) {
      this.send(client.ws, { type: 'error', message: 'Not attached to an iTerm2 session' });
      return;
    }
    this.doITermDetach(client);
    this.send(client.ws, { type: 'iterm.detached' });
  }

  private async handleITermInput(client: ClientState, data: string): Promise<void> {
    if (!client.itermSessionId) {
      this.send(client.ws, { type: 'error', message: 'Not attached to an iTerm2 session' });
      return;
    }

    const filtered = this.filterDsrResponses(data);
    if (!filtered) return;

    if (this.usePythonBridge && this.pythonBridge.isReady()) {
      this.pythonBridge.sendInput(filtered);
    } else {
      await this.itermBridge.sendInput(client.itermSessionId, filtered);
    }

    this.audit('input.write', client.id, null, client.remoteAddress, {
      itermSessionId: client.itermSessionId,
      bytes: data.length,
    });
  }

  private handleITermResize(client: ClientState, cols: number, rows: number): void {
    if (!client.itermSessionId) {
      this.send(client.ws, { type: 'error', message: 'Not attached to an iTerm2 session' });
      return;
    }

    if (this.usePythonBridge && this.pythonBridge.isReady()) {
      this.pythonBridge.sendResize(cols, rows);
    }
  }

  private handleITermGetHistory(client: ClientState, lines?: number): void {
    if (!client.itermSessionId) {
      this.send(client.ws, { type: 'error', message: 'Not attached to an iTerm2 session' });
      return;
    }

    if (this.usePythonBridge && this.pythonBridge.isReady()) {
      this.pythonBridge.sendGetHistory(lines ?? 100);
    } else {
      this.send(client.ws, { type: 'iterm.history', lines: [], hasMore: false, overflow: 0 });
    }
  }

  private doITermDetach(client: ClientState): void {
    if (!client.itermSessionId) return;

    if (this.usePythonBridge && this.pythonBridge.isReady()) {
      this.pythonBridge.sendDetach();
    }

    const listener = this.itermListeners.get(client.id);
    if (listener) {
      this.itermBridge.stopMonitoring(client.itermSessionId, listener);
      this.itermListeners.delete(client.id);
    }

    this.audit('iterm.detach', client.id, null, client.remoteAddress, {
      itermSessionId: client.itermSessionId,
    });
    client.itermSessionId = null;
  }

  private handleDisconnect(client: ClientState): void {
    if (client.itermSessionId) {
      this.doITermDetach(client);
    }
    if (client.sessionId) {
      this.detachClient(client);
    }
    this.audit('client.disconnect', client.id, client.sessionId, client.remoteAddress, {});
    this.clients.delete(client.id);
  }

  private detachClient(client: ClientState): void {
    const sessionId = client.sessionId;
    if (!sessionId) return;

    const permEvent = this.permissions.onClientDisconnect(sessionId, client.id);
    if (permEvent) {
      this.sessionManager.updateWriterId(sessionId, null);
      this.broadcastToSession(sessionId, {
        type: 'permission.changed',
        role: 'viewer',
        writerId: null,
      });
    }

    this.sessionManager.removeClient(sessionId, client.id);
    client.sessionId = null;

    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      this.broadcastToSession(sessionId, {
        type: 'client.left',
        clientId: client.id,
        viewerCount: session.viewerCount,
      });
    }

    this.audit('session.detach', client.id, sessionId, client.remoteAddress, {});
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.alive) {
          client.ws.terminate();
          continue;
        }
        client.alive = false;
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping();
        }
      }
    }, this.config.heartbeatInterval);
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcastToSession(sessionId: string, msg: ServerMessage, excludeClientId?: string): void {
    const clientIds = this.sessionManager.getClientsForSession(sessionId);
    for (const cid of clientIds) {
      if (cid === excludeClientId) continue;
      const client = this.clients.get(cid);
      if (client) {
        this.send(client.ws, msg);
      }
    }
  }

  private audit(
    eventType: AuditEventType,
    clientId: string,
    sessionId: string | null,
    remoteAddress: string,
    details: Record<string, unknown>,
  ): void {
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      eventType,
      clientId,
      sessionId,
      remoteAddress,
      details,
    }).catch(() => {
      // Non-blocking: swallow write errors to avoid crashing the server
    });
  }
}
