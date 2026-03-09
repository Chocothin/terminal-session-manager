import { platform } from 'node:os';
import type { ServerConfig } from './types.js';

const MIN_TOKEN_LENGTH = 32;

function detectShell(): string {
  if (platform() === 'win32') return 'powershell.exe';
  return process.env['SHELL'] || '/bin/bash';
}

function env(key: string): string | undefined {
  return process.env[`TSM_${key}`];
}

function envInt(key: string, fallback: number): number {
  const val = env(key);
  if (val === undefined) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function loadConfig(): ServerConfig {
  const authToken = env('AUTH_TOKEN');

  if (!authToken) {
    console.error('[config] FATAL: TSM_AUTH_TOKEN environment variable is required.');
    process.exit(1);
  }

  if (authToken.length < MIN_TOKEN_LENGTH) {
    console.error(`[config] FATAL: TSM_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (got ${authToken.length}).`);
    process.exit(1);
  }

  const config: ServerConfig = {
    port: envInt('PORT', 3001),
    host: env('HOST') || '127.0.0.1',
    authToken,
    sessionTtl: envInt('SESSION_TTL', 300_000),
    heartbeatInterval: envInt('HEARTBEAT_INTERVAL', 30_000),
    heartbeatTimeout: envInt('HEARTBEAT_TIMEOUT', 45_000),
    maxBufferSize: envInt('MAX_BUFFER_SIZE', 262_144),
    maxSessionsPerClient: envInt('MAX_SESSIONS_PER_CLIENT', 10),
    allowedOrigins: env('ALLOWED_ORIGINS') ? env('ALLOWED_ORIGINS')!.split(',').map(o => o.trim()) : [],
    logDir: env('LOG_DIR') || './logs',
    shell: env('SHELL') || detectShell(),
  };

  console.log('[config] Configuration loaded');

  return config;
}
