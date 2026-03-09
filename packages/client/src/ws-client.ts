import type { ClientMessage, ServerMessage, ConnectionState } from './types.js';

type ReconnectState = 'idle' | 'health-polling' | 'ws-connecting' | 'connected';

export class WsClient extends EventTarget {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private healthBaseUrl: string;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectState: ReconnectState = 'idle';
  private reconnectTimeout: number | null = null;
  private healthPollTimeout: number | null = null;
  private heartbeatInterval: number | null = null;
  private lastPongTime = 0;
  private isManualClose = false;
  private hiddenAt = 0;
  private consecutiveAuthFailures = 0;

  private static readonly BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

  constructor(url: string, token: string, healthBaseUrl: string) {
    super();
    this.url = url;
    this.token = token;
    this.healthBaseUrl = healthBaseUrl;

    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());
    document.addEventListener('visibilitychange', () => this.handleVisibilityChange());
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.reconnectState = 'ws-connecting';
    this.setState('connecting');
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener('open', () => this.handleOpen());
    this.ws.addEventListener('message', (event) => this.handleMessage(event));
    this.ws.addEventListener('close', () => this.handleClose());
    this.ws.addEventListener('error', () => this.handleError());
  }

  private handleOpen(): void {
    this.reconnectState = 'connected';
    this.setState('connected');
    this.reconnectAttempts = 0;
    this.send({ type: 'auth', token: this.token });
    this.startHeartbeat();
    this.dispatchEvent(new Event('connected'));
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message = JSON.parse(event.data) as ServerMessage;
      
      if (message.type === 'pong') {
        this.lastPongTime = Date.now();
      }

      if (message.type === 'auth.success') {
        this.consecutiveAuthFailures = 0;
        this.dispatchEvent(new CustomEvent('auth-success', { detail: message }));
      }

      if (message.type === 'auth.error') {
        this.consecutiveAuthFailures++;
        this.dispatchEvent(new CustomEvent('auth-error', { detail: message }));

        if (this.consecutiveAuthFailures >= 3) {
          this.reconnectState = 'idle';
          this.isManualClose = true;
          this.ws?.close();
          this.setState('disconnected');
          this.dispatchEvent(new Event('disconnected'));
          this.dispatchEvent(new Event('auth-failed-permanent'));
          return;
        }
      }

      this.dispatchEvent(new CustomEvent('message', { detail: message }));
    } catch (error) {
      console.error('Failed to parse message:', error);
    }
  }

  private handleClose(): void {
    this.stopHeartbeat();
    
    if (this.isManualClose) {
      this.reconnectState = 'idle';
      this.setState('disconnected');
      this.dispatchEvent(new Event('disconnected'));
      return;
    }

    this.setState('reconnecting');
    this.dispatchEvent(new Event('reconnecting'));
    this.startHealthPolling();
  }

  private handleError(): void {
    console.error('WebSocket error');
  }

  private handleOnline(): void {
    if (this.state === 'disconnected' || this.state === 'reconnecting') {
      this.reconnectAttempts = 0;
      this.isManualClose = false;
      this.setState('reconnecting');
      this.dispatchEvent(new Event('reconnecting'));
      this.startHealthPolling();
    }
  }

  private handleOffline(): void {
    this.stopHealthPolling();
    this.setState('disconnected');
  }

  private handleVisibilityChange(): void {
    if (document.hidden) {
      // Pause heartbeat: iOS freezes JS timers while hidden, causing
      // stale lastPongTime to trigger false timeout on wake
      this.hiddenAt = Date.now();
      this.stopHeartbeat();

      if (this.reconnectState === 'health-polling') {
        this.stopHealthPolling();
      }
    } else {
      const elapsed = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
      this.hiddenAt = 0;

      if (this.reconnectState === 'health-polling') {
        this.pollHealth();
      } else if (this.ws?.readyState === WebSocket.OPEN && elapsed <= 30000) {
        this.lastPongTime = Date.now();
        this.startHeartbeat();
        this.send({ type: 'ping' });
      } else {
        this.reconnectAttempts = 0;
        this.isManualClose = false;
        this.setState('reconnecting');
        this.dispatchEvent(new Event('reconnecting'));
        this.startHealthPolling();
      }
    }
  }

  private startHealthPolling(): void {
    this.stopHealthPolling();
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.reconnectState = 'health-polling';
    this.pollHealth();
  }

  private async pollHealth(): Promise<void> {
    if (this.reconnectState !== 'health-polling') return;

    this.reconnectAttempts++;
    this.emitReconnectStatus();

    try {
      const resp = await fetch(`${this.healthBaseUrl}/health`, { cache: 'no-store' });
      if (resp.ok && this.reconnectState === 'health-polling') {
        this.reconnectState = 'ws-connecting';
        this.emitReconnectStatus();
        this.connect();
        return;
      }
    } catch {
      // Network error — server unreachable
    }

    if (this.reconnectState === 'health-polling') {
      this.scheduleHealthPoll();
    }
  }

  private scheduleHealthPoll(): void {
    if (this.healthPollTimeout !== null) return;

    const delay = WsClient.BACKOFF_DELAYS[
      Math.min(this.reconnectAttempts, WsClient.BACKOFF_DELAYS.length - 1)
    ];

    this.healthPollTimeout = window.setTimeout(() => {
      this.healthPollTimeout = null;
      this.pollHealth();
    }, delay);
  }

  private stopHealthPolling(): void {
    if (this.healthPollTimeout !== null) {
      clearTimeout(this.healthPollTimeout);
      this.healthPollTimeout = null;
    }
  }

  private emitReconnectStatus(): void {
    this.dispatchEvent(new CustomEvent('reconnect-status', {
      detail: {
        attempt: this.reconnectAttempts,
        state: this.reconnectState,
        lastAttempt: Date.now(),
      },
    }));
  }

  private startHeartbeat(): void {
    this.lastPongTime = Date.now();
    this.heartbeatInterval = window.setInterval(() => {
      if (Date.now() - this.lastPongTime > 60000) {
        this.ws?.close();
        return;
      }
      this.send({ type: 'ping' });
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state;
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  reconnect(): void {
    this.isManualClose = false;
    this.reconnectAttempts = 0;
    this.consecutiveAuthFailures = 0;
    this.stopHealthPolling();
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.ws?.close();
    this.setState('reconnecting');
    this.dispatchEvent(new Event('reconnecting'));
    this.startHealthPolling();
  }

  close(): void {
    this.isManualClose = true;
    this.reconnectState = 'idle';
    this.stopHealthPolling();
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.stopHeartbeat();
    this.ws?.close();
  }

  getState(): ConnectionState {
    return this.state;
  }

  getReconnectInfo(): { attempt: number; state: string } {
    return { attempt: this.reconnectAttempts, state: this.reconnectState };
  }
}
