import type { ClientMessage } from './types.js';

/**
 * iTerm2 session IDs are UUIDs like "w0t0p0:F3A1B2C4-..."
 * Allow hex, hyphens, colons, and alphanumeric prefixes.
 */
const ITERM_SESSION_ID_RE = /^[A-Za-z0-9:.\-]{1,128}$/;

export function isValidITermSessionId(id: string): boolean {
  return ITERM_SESSION_ID_RE.test(id);
}

export function validateClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.type !== 'string') {
    return null;
  }

  const type = obj.type;

  if (type === 'auth') {
    if (typeof obj.token !== 'string') {
      return null;
    }
    return {
      type: 'auth',
      token: obj.token,
    } as ClientMessage;
  }

  if (type === 'session.create') {
    if (obj.name !== undefined) {
      if (typeof obj.name !== 'string' || obj.name.length > 64) {
        return null;
      }
    }

    if (obj.cols !== undefined) {
      if (!isPositiveInteger(obj.cols) || obj.cols > 500) {
        return null;
      }
    }

    if (obj.rows !== undefined) {
      if (!isPositiveInteger(obj.rows) || obj.rows > 500) {
        return null;
      }
    }

    return {
      type: 'session.create',
      name: obj.name as string | undefined,
      cols: obj.cols as number | undefined,
      rows: obj.rows as number | undefined,
    } as ClientMessage;
  }

  if (type === 'session.list') {
    return {
      type: 'session.list',
    } as ClientMessage;
  }

  if (type === 'session.attach') {
    if (typeof obj.sessionId !== 'string') {
      return null;
    }
    return {
      type: 'session.attach',
      sessionId: obj.sessionId,
    } as ClientMessage;
  }

  if (type === 'session.detach') {
    return {
      type: 'session.detach',
    } as ClientMessage;
  }

  if (type === 'session.kill') {
    if (typeof obj.sessionId !== 'string') {
      return null;
    }
    return {
      type: 'session.kill',
      sessionId: obj.sessionId,
    } as ClientMessage;
  }

  if (type === 'input') {
    if (typeof obj.data !== 'string' || obj.data.length > 4096) {
      return null;
    }
    return {
      type: 'input',
      data: obj.data,
    } as ClientMessage;
  }

  if (type === 'resize') {
    if (!isPositiveInteger(obj.cols) || obj.cols > 500) {
      return null;
    }
    if (!isPositiveInteger(obj.rows) || obj.rows > 500) {
      return null;
    }
    return {
      type: 'resize',
      cols: obj.cols as number,
      rows: obj.rows as number,
    } as ClientMessage;
  }

  if (type === 'permission.takeover') {
    return {
      type: 'permission.takeover',
    } as ClientMessage;
  }

  if (type === 'permission.release') {
    return {
      type: 'permission.release',
    } as ClientMessage;
  }

  if (type === 'ping') {
    return {
      type: 'ping',
    } as ClientMessage;
  }

  if (type === 'iterm.list') {
    return { type: 'iterm.list' } as ClientMessage;
  }

  if (type === 'iterm.create') {
    return { type: 'iterm.create' } as ClientMessage;
  }

  if (type === 'iterm.kill') {
    if (typeof obj.itermSessionId !== 'string' || !isValidITermSessionId(obj.itermSessionId)) {
      return null;
    }
    return {
      type: 'iterm.kill',
      itermSessionId: obj.itermSessionId,
    } as ClientMessage;
  }

  if (type === 'iterm.attach') {
    if (typeof obj.itermSessionId !== 'string' || !isValidITermSessionId(obj.itermSessionId)) {
      return null;
    }
    if (obj.cols !== undefined && (!isPositiveInteger(obj.cols) || obj.cols > 500)) {
      return null;
    }
    if (obj.rows !== undefined && (!isPositiveInteger(obj.rows) || obj.rows > 500)) {
      return null;
    }
    return {
      type: 'iterm.attach',
      itermSessionId: obj.itermSessionId,
      cols: obj.cols as number | undefined,
      rows: obj.rows as number | undefined,
    } as ClientMessage;
  }

  if (type === 'iterm.detach') {
    return { type: 'iterm.detach' } as ClientMessage;
  }

  if (type === 'iterm.input') {
    if (typeof obj.data !== 'string' || obj.data.length > 4096) {
      return null;
    }
    return {
      type: 'iterm.input',
      data: obj.data,
    } as ClientMessage;
  }

  if (type === 'iterm.resize') {
    if (!isPositiveInteger(obj.cols) || obj.cols > 500) {
      return null;
    }
    if (!isPositiveInteger(obj.rows) || obj.rows > 500) {
      return null;
    }
    return {
      type: 'iterm.resize',
      cols: obj.cols as number,
      rows: obj.rows as number,
    } as ClientMessage;
  }

  if (type === 'iterm.getHistory') {
    if (obj.lines !== undefined && (typeof obj.lines !== 'number' || !Number.isInteger(obj.lines) || obj.lines > 10000)) {
      return null;
    }
    return {
      type: 'iterm.getHistory',
      lines: obj.lines as number | undefined,
    } as ClientMessage;
  }

  return null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
