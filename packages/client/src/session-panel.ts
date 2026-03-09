import type { SessionInfo, ITermSessionInfo } from './types.js';
import type { WsClient } from './ws-client.js';
import { hapticFeedback } from './haptics.js';

type UnifiedSession =
  | { kind: 'pty'; data: SessionInfo }
  | { kind: 'iterm'; data: ITermSessionInfo };

export class SessionPanel {
  private container: HTMLElement;
  private wsClient: WsClient;
  private sessions: SessionInfo[] = [];
  private itermSessions: ITermSessionInfo[] = [];
  private activeSessionId: string | null = null;
  private activeItermSessionId: string | null = null;
  private listElement: HTMLElement;
  private pullIndicator: HTMLElement;
  private dimensionsGetter: (() => { cols: number; rows: number }) | null = null;

  constructor(parent: HTMLElement, wsClient: WsClient) {
    this.wsClient = wsClient;

    this.container = document.createElement('div');
    this.container.className = 'session-panel';

    const header = document.createElement('div');
    header.className = 'session-panel-header';

    const title = document.createElement('h2');
    title.textContent = 'Sessions';

    const btnGroup = document.createElement('div');
    btnGroup.className = 'header-btn-group';

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn-iterm-refresh';
    refreshBtn.textContent = '↻';
    refreshBtn.title = 'Refresh';
    refreshBtn.addEventListener('click', () => {
      hapticFeedback('light');
      this.wsClient.send({ type: 'session.list' });
      this.wsClient.send({ type: 'iterm.list' });
    });

    const newButton = document.createElement('button');
    newButton.className = 'btn-new-session';
    newButton.textContent = '+ New';
    newButton.addEventListener('click', () => {
      hapticFeedback('medium');
      this.handleNewSession();
    });

    btnGroup.appendChild(refreshBtn);
    btnGroup.appendChild(newButton);
    header.appendChild(title);
    header.appendChild(btnGroup);

    this.listElement = document.createElement('div');
    this.listElement.className = 'session-list';

    this.pullIndicator = document.createElement('div');
    this.pullIndicator.className = 'pull-to-refresh-indicator';
    this.pullIndicator.innerHTML = '<div class="ptr-spinner"></div><span>Refreshing...</span>';

    this.container.appendChild(header);
    this.container.appendChild(this.pullIndicator);
    this.container.appendChild(this.listElement);

    parent.appendChild(this.container);

    this.setupPullToRefresh();
  }

  private handleNewSession(): void {
    this.wsClient.send({ type: 'iterm.create' });
  }

  setDimensionsGetter(getter: () => { cols: number; rows: number }): void {
    this.dimensionsGetter = getter;
  }

  updateSessions(sessions: SessionInfo[]): void {
    this.sessions = sessions;
    this.renderAll();
  }

  updateItermSessions(sessions: ITermSessionInfo[]): void {
    this.itermSessions = sessions;
    this.renderAll();
  }

  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
    if (sessionId) {
      this.activeItermSessionId = null;
    }
    this.renderAll();
  }

  setActiveItermSession(sessionId: string | null): void {
    this.activeItermSessionId = sessionId;
    if (sessionId) {
      this.activeSessionId = null;
    }
    this.renderAll();
  }

  refresh(): void {
    hapticFeedback('medium');
    this.pullIndicator.classList.add('active');
    this.wsClient.send({ type: 'session.list' });
    this.wsClient.send({ type: 'iterm.list' });
    setTimeout(() => {
      this.pullIndicator.classList.remove('active');
    }, 500);
  }

  private renderAll(): void {
    this.listElement.innerHTML = '';

    const unified: UnifiedSession[] = [
      ...this.itermSessions.map((s): UnifiedSession => ({ kind: 'iterm', data: s })),
      ...this.sessions.map((s): UnifiedSession => ({ kind: 'pty', data: s })),
    ];

    if (unified.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'session-list-empty';
      empty.textContent = 'No sessions';
      this.listElement.appendChild(empty);
      return;
    }

    for (const entry of unified) {
      if (entry.kind === 'iterm') {
        this.renderItermItem(entry.data);
      } else {
        this.renderPtyItem(entry.data);
      }
    }
  }

  private renderPtyItem(session: SessionInfo): void {
    const item = document.createElement('div');
    item.className = 'session-item';

    if (session.id === this.activeSessionId) {
      item.classList.add('active');
    }

    const info = document.createElement('div');
    info.className = 'session-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'session-name-row';

    const statusDot = document.createElement('span');
    statusDot.className = 'session-status-dot';

    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = session.name;

    const badge = document.createElement('span');
    badge.className = 'session-badge pty-badge';
    badge.textContent = 'PTY';

    nameRow.appendChild(statusDot);
    nameRow.appendChild(name);
    nameRow.appendChild(badge);

    const meta = document.createElement('div');
    meta.className = 'session-meta';

    const viewerCount = document.createElement('span');
    viewerCount.className = 'session-viewers';
    viewerCount.textContent = `${session.viewerCount} viewer${session.viewerCount !== 1 ? 's' : ''}`;

    const created = document.createElement('span');
    created.className = 'session-created';
    created.textContent = this.formatTime(session.createdAt);

    meta.appendChild(viewerCount);
    meta.appendChild(created);

    info.appendChild(nameRow);
    info.appendChild(meta);

    const killButton = document.createElement('button');
    killButton.className = 'btn-kill-session';
    killButton.textContent = '×';
    killButton.title = 'Kill session';
    killButton.addEventListener('click', (e) => {
      e.stopPropagation();
      hapticFeedback('heavy');
      this.wsClient.send({ type: 'session.kill', sessionId: session.id });
    });

    item.appendChild(info);
    item.appendChild(killButton);

    item.addEventListener('click', () => {
      if (this.activeSessionId !== session.id) {
        hapticFeedback('light');
        this.wsClient.send({ type: 'session.attach', sessionId: session.id });
      }
    });

    this.listElement.appendChild(item);
  }

  private renderItermItem(session: ITermSessionInfo): void {
    const item = document.createElement('div');
    item.className = 'session-item iterm-item';

    if (session.id === this.activeItermSessionId) {
      item.classList.add('active');
    }

    const info = document.createElement('div');
    info.className = 'session-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'session-name-row';

    const statusDot = document.createElement('span');
    statusDot.className = 'session-status-dot iterm-dot';

    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = session.name;

    const badge = document.createElement('span');
    badge.className = 'session-badge iterm-badge';
    badge.textContent = 'iTerm2';

    nameRow.appendChild(statusDot);
    nameRow.appendChild(name);
    nameRow.appendChild(badge);

    const meta = document.createElement('div');
    meta.className = 'session-meta';

    const tty = document.createElement('span');
    tty.textContent = session.tty;

    const dims = document.createElement('span');
    dims.textContent = `${session.cols}×${session.rows}`;

    meta.appendChild(tty);
    meta.appendChild(dims);

    info.appendChild(nameRow);
    info.appendChild(meta);

    const killButton = document.createElement('button');
    killButton.className = 'btn-kill-session';
    killButton.textContent = '×';
    killButton.title = 'Close iTerm session';
    killButton.addEventListener('click', (e) => {
      e.stopPropagation();
      hapticFeedback('heavy');
      this.wsClient.send({ type: 'iterm.kill', itermSessionId: session.id });
    });

    item.appendChild(info);
    item.appendChild(killButton);

    item.addEventListener('click', () => {
      if (this.activeItermSessionId !== session.id) {
        hapticFeedback('light');
        const dims = this.dimensionsGetter?.();
        this.wsClient.send({
          type: 'iterm.attach',
          itermSessionId: session.id,
          cols: dims?.cols,
          rows: dims?.rows,
        });
      }
    });

    this.listElement.appendChild(item);
  }

  private formatTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
  }

  private setupPullToRefresh(): void {
    if (!('ontouchstart' in window)) return;
    let startY = 0;
    this.listElement.addEventListener('touchstart', (e) => {
      if (this.listElement.scrollTop === 0) {
        startY = e.touches[0]?.clientY ?? 0;
      }
    }, { passive: true });
    this.listElement.addEventListener('touchend', (e) => {
      const endY = e.changedTouches[0]?.clientY ?? 0;
      if (endY - startY > 60 && this.listElement.scrollTop === 0) {
        this.refresh();
      }
    }, { passive: true });
  }
}
