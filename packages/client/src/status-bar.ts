import type { ConnectionState, PermissionRole } from './types.js';

interface StatusBarState {
  connection: ConnectionState;
  sessionName: string | null;
  role: PermissionRole | 'iterm' | null;
  writerId: string | null;
  viewerCount: number;
}

export class StatusBar {
  private container: HTMLElement;
  private connectionElement: HTMLElement;
  private sessionElement: HTMLElement;
  private roleElement: HTMLElement;
  private writerElement: HTMLElement;
  private viewerElement: HTMLElement;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'status-bar';

    this.connectionElement = document.createElement('div');
    this.connectionElement.className = 'status-connection';

    this.sessionElement = document.createElement('div');
    this.sessionElement.className = 'status-session';

    this.roleElement = document.createElement('div');
    this.roleElement.className = 'status-role';

    this.writerElement = document.createElement('div');
    this.writerElement.className = 'status-writer';

    this.viewerElement = document.createElement('div');
    this.viewerElement.className = 'status-viewers';

    this.container.appendChild(this.connectionElement);
    this.container.appendChild(this.sessionElement);
    this.container.appendChild(this.roleElement);
    this.container.appendChild(this.writerElement);
    this.container.appendChild(this.viewerElement);

    parent.appendChild(this.container);
  }

  update(state: StatusBarState): void {
    this.updateConnection(state.connection);
    this.updateSession(state.sessionName);
    this.updateRole(state.role);
    this.updateWriter(state.writerId);
    this.updateViewers(state.viewerCount);
  }

  private updateConnection(connection: ConnectionState): void {
    const icons: Record<ConnectionState, string> = {
      connected: '🟢',
      connecting: '🟡',
      reconnecting: '🟡',
      disconnected: '🔴',
    };

    const labels: Record<ConnectionState, string> = {
      connected: 'Connected',
      connecting: 'Connecting',
      reconnecting: 'Reconnecting',
      disconnected: 'Disconnected',
    };

    this.connectionElement.textContent = `${icons[connection]} ${labels[connection]}`;
    this.connectionElement.dataset.state = connection;
  }

  private updateSession(sessionName: string | null): void {
    if (sessionName) {
      this.sessionElement.textContent = `Session: ${sessionName}`;
      this.sessionElement.style.display = 'block';
    } else {
      this.sessionElement.style.display = 'none';
    }
  }

  private updateRole(role: PermissionRole | 'iterm' | null): void {
    if (role) {
      const badge = document.createElement('span');
      badge.className = `role-badge role-${role}`;
      badge.textContent = role === 'iterm' ? 'iTERM2' : role.toUpperCase();
      this.roleElement.innerHTML = '';
      this.roleElement.appendChild(badge);
      this.roleElement.style.display = 'block';
    } else {
      this.roleElement.style.display = 'none';
    }
  }

  private updateWriter(writerId: string | null): void {
    if (writerId) {
      this.writerElement.textContent = `Writer: ${writerId.slice(0, 8)}`;
      this.writerElement.style.display = 'block';
    } else {
      this.writerElement.textContent = 'No writer';
      this.writerElement.style.display = 'block';
    }
  }

  private updateViewers(count: number): void {
    this.viewerElement.textContent = `${count} viewer${count !== 1 ? 's' : ''}`;
  }
}
