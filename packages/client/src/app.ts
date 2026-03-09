import type { AppState, ServerMessage } from './types.js';
import { WsClient } from './ws-client.js';
import { TerminalView } from './terminal-view.js';
import { SessionPanel } from './session-panel.js';
import { StatusBar } from './status-bar.js';
import { PermissionControls } from './permission-controls.js';
import { AuthScreen } from './auth-screen.js';
import { TouchGestures } from './touch-gestures.js';
import { hapticFeedback } from './haptics.js';
import { IOSViewportFix } from './ios-viewport-fix.js';

const LAST_SESSION_KEY = 'tsm-last-session';

interface LastSession {
  type: 'pty' | 'iterm';
  sessionId: string;
}

export class App {
  private wsClient: WsClient | null = null;
  private terminalView: TerminalView | null = null;
  private sessionPanel: SessionPanel | null = null;
  private statusBar: StatusBar | null = null;
  private permissionControls: PermissionControls | null = null;
  private authScreen: AuthScreen;
  private mainLayout: HTMLElement | null = null;
  private reconnectOverlay: HTMLElement | null = null;
  private reconnectStatusEl: HTMLElement | null = null;
  private reconnectRetryEl: HTMLElement | null = null;
  private reconnectLastAttemptEl: HTMLElement | null = null;
  private displayRetryCount = 0;
  private reconnectStatusTimer: number | null = null;
  private historyLoading = false;
  private pendingScreenOutputs: string[] = [];
  private iosViewportFix: IOSViewportFix | null = null;
  private hasAutoReattached = false;
  private wakeLock: WakeLockSentinel | null = null;

  private state: AppState = {
    connection: 'disconnected',
    clientId: null,
    currentSession: null,
    role: null,
    sessions: [],
    itermSession: null,
    itermSessions: [],
  };

  constructor(container: HTMLElement) {
    this.authScreen = new AuthScreen(container);
    this.authScreen.onSubmit((token) => this.handleAuth(token));
    this.authScreen.show();
    
    this.iosViewportFix = new IOSViewportFix();

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && (this.state.currentSession || this.state.itermSession)) {
        this.requestWakeLock();
      }
    });
  }

  private handleAuth(token: string): void {
    const wsUrl = this.getWebSocketUrl();
    const httpProtocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const httpHost = import.meta.env.DEV ? 'localhost:3001' : window.location.host;
    const healthBaseUrl = `${httpProtocol}//${httpHost}`;
    this.wsClient = new WsClient(wsUrl, token, healthBaseUrl);

    this.wsClient.addEventListener('connected', () => {
      this.updateConnectionState('connected');
    });

    this.wsClient.addEventListener('disconnected', () => {
      this.updateConnectionState('disconnected');
      this.showReconnectOverlay();
    });

    this.wsClient.addEventListener('reconnecting', () => {
      this.updateConnectionState('reconnecting');
      this.showReconnectOverlay();
    });

    this.wsClient.addEventListener('auth-success', ((event: CustomEvent) => {
      const message = event.detail as Extract<ServerMessage, { type: 'auth.success' }>;
      this.state.clientId = message.clientId;
      this.authScreen.hide();
      const isReconnect = this.mainLayout !== null;
      if (!isReconnect) {
        this.initMainLayout();
      }
      this.wsClient?.send({ type: 'session.list' });
      this.wsClient?.send({ type: 'iterm.list' });
      if (isReconnect || !this.hasAutoReattached) {
        this.hasAutoReattached = true;
        this.tryAutoReattach();
      }
      this.hideReconnectOverlay();
    }) as EventListener);

    this.wsClient.addEventListener('auth-error', ((event: CustomEvent) => {
      const message = event.detail as Extract<ServerMessage, { type: 'auth.error' }>;
      this.authScreen.showError(message.message);
    }) as EventListener);

    this.wsClient.addEventListener('message', ((event: CustomEvent) => {
      this.handleServerMessage(event.detail as ServerMessage);
    }) as EventListener);

    this.wsClient.addEventListener('reconnect-status', ((event: CustomEvent) => {
      const detail = event.detail as { attempt: number; state: string; lastAttempt: number };
      this.updateReconnectOverlay(detail);
    }) as EventListener);

    this.wsClient.connect();
  }

  private initMainLayout(): void {
    const appContainer = this.authScreen['container'].parentElement;
    if (!appContainer) return;

    this.mainLayout = document.createElement('div');
    this.mainLayout.className = 'main-layout';

    const sidebarToggle = document.createElement('button');
    sidebarToggle.className = 'sidebar-toggle';
    sidebarToggle.textContent = '☰';
    sidebarToggle.addEventListener('click', () => {
      hapticFeedback('light');
      this.toggleSidebar();
    });

    const sidebar = document.createElement('div');
    sidebar.className = 'sidebar';

    const mainContent = document.createElement('div');
    mainContent.className = 'main-content';

    const terminalContainer = document.createElement('div');
    terminalContainer.className = 'terminal-container';

    const controlsContainer = document.createElement('div');
    controlsContainer.className = 'controls-container';

    const statusBarContainer = document.createElement('div');
    statusBarContainer.className = 'status-bar-container';

    if (this.wsClient) {
      this.sessionPanel = new SessionPanel(sidebar, this.wsClient);
      this.terminalView = new TerminalView(terminalContainer);
      this.permissionControls = new PermissionControls(controlsContainer, this.wsClient);
      this.statusBar = new StatusBar(statusBarContainer);

      this.sessionPanel.setDimensionsGetter(() => this.terminalView!.getDimensions());

      this.terminalView.onInput((data) => {
        if (this.state.itermSession) {
          this.wsClient?.send({ type: 'iterm.input', data });
        } else if (this.state.role === 'writer') {
          this.wsClient?.send({ type: 'input', data });
        }
      });

      this.terminalView.onResize((cols, rows) => {
        if (this.terminalView?.isInItermMode()) return;
        if (this.state.role === 'writer') {
          this.wsClient?.send({ type: 'resize', cols, rows });
        }
      });
    }

    mainContent.appendChild(sidebarToggle);
    mainContent.appendChild(terminalContainer);
    mainContent.appendChild(controlsContainer);
    mainContent.appendChild(statusBarContainer);

    this.mainLayout.appendChild(sidebar);
    this.mainLayout.appendChild(mainContent);

    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    backdrop.addEventListener('click', () => {
      hapticFeedback('light');
      this.closeSidebar();
    });
    this.mainLayout.appendChild(backdrop);

    new TouchGestures(this.mainLayout, {
      onSwipeRight: () => {
        hapticFeedback('light');
        this.openSidebar();
      },
      onSwipeLeft: () => {
        hapticFeedback('light');
        this.closeSidebar();
      },
    });

    appContainer.appendChild(this.mainLayout);

    this.createReconnectOverlay(appContainer);
    this.updateStatusBar();
  }

  private createReconnectOverlay(container: HTMLElement): void {
    this.reconnectOverlay = document.createElement('div');
    this.reconnectOverlay.className = 'reconnect-overlay';
    this.reconnectOverlay.style.display = 'none';

    const content = document.createElement('div');
    content.className = 'reconnect-content';

    const spinner = document.createElement('div');
    spinner.className = 'spinner';

    const detail = document.createElement('div');
    detail.className = 'reconnect-detail';

    const message = document.createElement('div');
    message.className = 'reconnect-message';
    message.textContent = 'Reconnecting...';

    this.reconnectStatusEl = document.createElement('span');
    this.reconnectStatusEl.className = 'reconnect-status';

    this.reconnectRetryEl = document.createElement('span');
    this.reconnectRetryEl.className = 'reconnect-retry-count';

    this.reconnectLastAttemptEl = document.createElement('span');
    this.reconnectLastAttemptEl.className = 'reconnect-last-attempt';

    detail.appendChild(message);
    detail.appendChild(this.reconnectStatusEl);
    detail.appendChild(this.reconnectRetryEl);
    detail.appendChild(this.reconnectLastAttemptEl);

    const button = document.createElement('button');
    button.className = 'btn-reconnect-now';
    button.textContent = 'Reconnect Now';
    button.addEventListener('click', () => {
      this.wsClient?.reconnect();
    });

    content.appendChild(spinner);
    content.appendChild(detail);
    content.appendChild(button);
    this.reconnectOverlay.appendChild(content);

    container.appendChild(this.reconnectOverlay);
  }

  private showReconnectOverlay(): void {
    if (this.reconnectOverlay) {
      this.reconnectOverlay.style.display = 'flex';
    }
  }

  private hideReconnectOverlay(): void {
    if (this.reconnectOverlay) {
      this.reconnectOverlay.style.display = 'none';
    }
    this.displayRetryCount = 0;
    if (this.reconnectStatusTimer !== null) {
      clearInterval(this.reconnectStatusTimer);
      this.reconnectStatusTimer = null;
    }
  }

  private updateReconnectOverlay(detail: { attempt: number; state: string; lastAttempt: number }): void {
    this.displayRetryCount++;

    if (this.reconnectStatusEl) {
      const statusText = detail.state === 'health-polling' ? 'Checking server...'
        : detail.state === 'ws-connecting' ? 'Connecting...'
        : 'Reconnecting...';
      this.reconnectStatusEl.textContent = statusText;
    }

    if (this.reconnectRetryEl) {
      this.reconnectRetryEl.textContent = `Attempt ${this.displayRetryCount}`;
    }

    this.updateLastAttemptTime(detail.lastAttempt);
  }

  private updateLastAttemptTime(timestamp: number): void {
    if (this.reconnectStatusTimer !== null) {
      clearInterval(this.reconnectStatusTimer);
    }

    const update = () => {
      if (!this.reconnectLastAttemptEl) return;
      const seconds = Math.round((Date.now() - timestamp) / 1000);
      this.reconnectLastAttemptEl.textContent = seconds < 5 ? 'Just now' : `${seconds}s ago`;
    };

    update();
    this.reconnectStatusTimer = window.setInterval(update, 1000);
  }

  private toggleSidebar(): void {
    const sidebar = this.mainLayout?.querySelector('.sidebar');
    if (sidebar?.classList.contains('open')) {
      this.closeSidebar();
    } else {
      this.openSidebar();
    }
  }

  private openSidebar(): void {
    const sidebar = this.mainLayout?.querySelector('.sidebar');
    const backdrop = this.mainLayout?.querySelector('.sidebar-backdrop');
    sidebar?.classList.add('open');
    backdrop?.classList.add('active');
  }

  private closeSidebar(): void {
    const sidebar = this.mainLayout?.querySelector('.sidebar');
    const backdrop = this.mainLayout?.querySelector('.sidebar-backdrop');
    sidebar?.classList.remove('open');
    backdrop?.classList.remove('active');
  }

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'session.list':
        this.state.sessions = message.sessions;
        this.sessionPanel?.updateSessions(message.sessions);
        break;

      case 'session.created':
        this.state.sessions.push(message.session);
        this.sessionPanel?.updateSessions(this.state.sessions);
        this.wsClient?.send({ type: 'session.attach', sessionId: message.session.id });
        break;

      case 'session.attached':
        this.state.itermSession = null;
        this.sessionPanel?.setActiveItermSession(null);
        if (this.terminalView?.isInItermMode()) {
          this.terminalView.exitItermMode();
        }
        this.state.currentSession = message.session;
        this.state.role = message.role;
        this.sessionPanel?.setActiveSession(message.session.id);
        this.terminalView?.clear();
        this.terminalView?.write(message.buffer);
        this.terminalView?.setReadOnly(message.role === 'viewer');
        this.terminalView?.focus();
        this.permissionControls?.setRole(message.role);
        this.saveLastSession({ type: 'pty', sessionId: message.session.id });
        this.requestWakeLock();
        this.updateStatusBar();
        this.hideReconnectOverlay();
        this.closeSidebar();
        break;

      case 'session.detached':
        this.state.currentSession = null;
        this.state.role = null;
        this.sessionPanel?.setActiveSession(null);
        this.terminalView?.clear();
        this.permissionControls?.setRole(null);
        this.clearLastSession();
        this.releaseWakeLock();
        this.updateStatusBar();
        break;

      case 'session.killed':
        this.state.sessions = this.state.sessions.filter((s) => s.id !== message.sessionId);
        this.sessionPanel?.updateSessions(this.state.sessions);
        if (this.state.currentSession?.id === message.sessionId) {
          this.state.currentSession = null;
          this.state.role = null;
          this.terminalView?.clear();
          this.permissionControls?.setRole(null);
          this.clearLastSession();
          this.updateStatusBar();
        }
        break;

      case 'session.ended':
        this.state.sessions = this.state.sessions.filter((s) => s.id !== message.sessionId);
        this.sessionPanel?.updateSessions(this.state.sessions);
        if (this.state.currentSession?.id === message.sessionId) {
          this.terminalView?.write(`\r\n\r\n[Session ended with exit code ${message.exitCode}]\r\n`);
          this.state.currentSession = null;
          this.state.role = null;
          this.permissionControls?.setRole(null);
          this.clearLastSession();
          this.updateStatusBar();
        }
        break;

      case 'output':
        this.terminalView?.writeStream(message.data);
        break;

      case 'permission.changed':
        this.state.role = message.role;
        if (this.state.currentSession) {
          this.state.currentSession.writerId = message.writerId;
        }
        this.terminalView?.setReadOnly(message.role === 'viewer');
        this.permissionControls?.setRole(message.role);
        this.updateStatusBar();
        break;

      case 'permission.denied':
        this.permissionControls?.setDenied(message.reason);
        break;

      case 'client.joined':
        if (this.state.currentSession) {
          this.state.currentSession.viewerCount = message.viewerCount;
        }
        this.updateStatusBar();
        break;

      case 'client.left':
        if (this.state.currentSession) {
          this.state.currentSession.viewerCount = message.viewerCount;
        }
        this.updateStatusBar();
        break;

      case 'iterm.created': {
        const dims = this.terminalView?.getDimensions();
        this.wsClient?.send({
          type: 'iterm.attach',
          itermSessionId: message.session.id,
          cols: dims?.cols,
          rows: dims?.rows,
        });
        break;
      }

      case 'iterm.killed':
        this.state.itermSessions = this.state.itermSessions.filter(
          (s) => s.id !== message.itermSessionId,
        );
        this.sessionPanel?.updateItermSessions(this.state.itermSessions);
        if (this.state.itermSession?.id === message.itermSessionId) {
          this.state.itermSession = null;
          this.terminalView?.clear();
          this.terminalView?.exitItermMode();
          this.sessionPanel?.setActiveItermSession(null);
          this.updateStatusBar();
        }
        break;

      case 'iterm.list':
        this.state.itermSessions = message.sessions;
        this.sessionPanel?.updateItermSessions(message.sessions);
        break;

      case 'iterm.attached': {
        this.state.currentSession = null;
        this.state.role = null;
        this.state.itermSession = message.session;
        this.historyLoading = true;
        this.pendingScreenOutputs = [];
        this.sessionPanel?.setActiveSession(null);
        this.sessionPanel?.setActiveItermSession(message.session.id);
        this.terminalView?.clear();
        this.terminalView?.enterItermMode(message.session.cols, message.session.rows);
        this.terminalView?.write('\x1b[2J\x1b[H');
        this.wsClient?.send({ type: 'iterm.getHistory', lines: -1 });
        this.terminalView?.setReadOnly(false);
        this.terminalView?.focus();
        this.permissionControls?.setRole(null);
        this.saveLastSession({ type: 'iterm', sessionId: message.session.id });
        this.requestWakeLock();
        this.updateStatusBar();
        this.hideReconnectOverlay();
        this.closeSidebar();
        break;
      }

      case 'iterm.output':
        if (this.state.itermSession) {
          if (this.historyLoading) {
            this.pendingScreenOutputs.push(message.data);
          } else {
            this.terminalView?.writeStream(message.data);
          }
        }
        break;

      case 'iterm.detached':
        this.state.itermSession = null;
        this.sessionPanel?.setActiveItermSession(null);
        if (this.terminalView?.isInItermMode()) {
          this.terminalView.exitItermMode();
        }
        this.terminalView?.clear();
        this.clearLastSession();
        this.releaseWakeLock();
        this.updateStatusBar();
        break;

      case 'iterm.error':
        console.error('iTerm2 error:', message.message);
        break;

      case 'iterm.unavailable':
        this.sessionPanel?.updateItermSessions([]);
        break;

      case 'iterm.history':
        if (message.lines.length > 0) {
          this.terminalView?.writeHistory(message.lines);
        }
        this.historyLoading = false;
        for (const pending of this.pendingScreenOutputs) {
          this.terminalView?.write(pending);
        }
        this.pendingScreenOutputs = [];
        break;

      case 'error':
        console.error('Server error:', message.message);
        break;
    }
  }

  private updateConnectionState(connection: AppState['connection']): void {
    this.state.connection = connection;
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    const itermName = this.state.itermSession?.name ?? null;
    this.statusBar?.update({
      connection: this.state.connection,
      sessionName: itermName ?? (this.state.currentSession?.name ?? null),
      role: this.state.itermSession ? 'iterm' : this.state.role,
      writerId: this.state.currentSession?.writerId ?? null,
      viewerCount: this.state.currentSession?.viewerCount ?? 0,
    });
  }

  private async requestWakeLock(): Promise<void> {
    if (!('wakeLock' in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
      });
    } catch {
      // Wake lock request can fail (low battery, etc.)
    }
  }

  private releaseWakeLock(): void {
    this.wakeLock?.release();
    this.wakeLock = null;
  }

  private saveLastSession(session: LastSession): void {
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(session));
  }

  private loadLastSession(): LastSession | null {
    try {
      const raw = localStorage.getItem(LAST_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private clearLastSession(): void {
    localStorage.removeItem(LAST_SESSION_KEY);
  }

  private tryAutoReattach(): void {
    const last = this.loadLastSession();
    if (!last) return;

    if (last.type === 'iterm') {
      this.wsClient?.send({ type: 'iterm.attach', itermSessionId: last.sessionId });
    } else {
      this.wsClient?.send({ type: 'session.attach', sessionId: last.sessionId });
    }
  }

  private getWebSocketUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = import.meta.env.DEV ? 'localhost:3001' : window.location.host;
    return `${protocol}//${host}`;
  }
}
