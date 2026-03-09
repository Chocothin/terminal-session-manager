import type { PermissionRole } from './types.js';

export interface RoleChangeEvent {
  sessionId: string;
  clientId: string;
  role: PermissionRole;
  writerId: string | null;
}

export class PermissionController {
  private readonly writers = new Map<string, string | null>();

  initSession(sessionId: string): void {
    this.writers.set(sessionId, null);
  }

  removeSession(sessionId: string): void {
    this.writers.delete(sessionId);
  }

  getRole(sessionId: string, clientId: string): PermissionRole {
    return this.writers.get(sessionId) === clientId ? 'writer' : 'viewer';
  }

  getWriterId(sessionId: string): string | null {
    return this.writers.get(sessionId) ?? null;
  }

  takeover(
    sessionId: string,
    clientId: string,
  ): { granted: true; event: RoleChangeEvent } | { granted: false; reason: string } {
    const currentWriter = this.writers.get(sessionId);

    if (currentWriter && currentWriter !== clientId) {
      return {
        granted: false,
        reason: `Client ${currentWriter} currently holds write permission`,
      };
    }

    this.writers.set(sessionId, clientId);
    return {
      granted: true,
      event: {
        sessionId,
        clientId,
        role: 'writer',
        writerId: clientId,
      },
    };
  }

  release(sessionId: string, clientId: string): RoleChangeEvent | null {
    const currentWriter = this.writers.get(sessionId);
    if (currentWriter !== clientId) return null;

    this.writers.set(sessionId, null);
    return {
      sessionId,
      clientId,
      role: 'viewer',
      writerId: null,
    };
  }

  onClientDisconnect(sessionId: string, clientId: string): RoleChangeEvent | null {
    return this.release(sessionId, clientId);
  }
}
