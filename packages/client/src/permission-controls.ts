import type { PermissionRole } from './types.js';
import type { WsClient } from './ws-client.js';
import { hapticFeedback } from './haptics.js';

export class PermissionControls {
  private container: HTMLElement;
  private wsClient: WsClient;
  private role: PermissionRole | null = null;
  private button: HTMLButtonElement;
  private messageElement: HTMLElement;
  private messageTimeout: number | null = null;

  constructor(parent: HTMLElement, wsClient: WsClient) {
    this.wsClient = wsClient;

    this.container = document.createElement('div');
    this.container.className = 'permission-controls';

    this.button = document.createElement('button');
    this.button.className = 'btn-permission';
    this.button.addEventListener('click', () => this.handleClick());

    this.messageElement = document.createElement('div');
    this.messageElement.className = 'permission-message';

    this.container.appendChild(this.button);
    this.container.appendChild(this.messageElement);

    parent.appendChild(this.container);

    this.render();
  }

  setRole(role: PermissionRole | null): void {
    this.role = role;
    this.render();
  }

  setDenied(reason: string): void {
    this.showMessage(reason, 'error');
  }

  private handleClick(): void {
    if (this.role === 'viewer') {
      hapticFeedback('medium');
      this.wsClient.send({ type: 'permission.takeover' });
    } else if (this.role === 'writer') {
      hapticFeedback('light');
      this.wsClient.send({ type: 'permission.release' });
    }
  }

  private render(): void {
    if (!this.role) {
      this.container.style.display = 'none';
      return;
    }

    this.container.style.display = 'flex';

    if (this.role === 'viewer') {
      this.button.textContent = 'Take Control';
      this.button.className = 'btn-permission btn-takeover';
    } else {
      this.button.textContent = 'Release Control';
      this.button.className = 'btn-permission btn-release';
    }
  }

  private showMessage(message: string, type: 'error' | 'success'): void {
    if (this.messageTimeout !== null) {
      clearTimeout(this.messageTimeout);
    }

    this.messageElement.textContent = message;
    this.messageElement.className = `permission-message permission-message-${type}`;
    this.messageElement.style.display = 'block';

    this.messageTimeout = window.setTimeout(() => {
      this.messageElement.style.display = 'none';
      this.messageTimeout = null;
    }, 3000);
  }
}
