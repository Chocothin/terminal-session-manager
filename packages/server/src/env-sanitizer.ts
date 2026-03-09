/**
 * Environment variable sanitizer for PTY processes
 * Uses an allowlist approach to prevent leaking sensitive environment variables
 * (API keys, database URLs, credentials, etc.) into spawned terminal sessions
 */

/**
 * Allowlist of safe environment variables to pass to PTY processes
 * Only these variables will be included in the sanitized environment
 */
export const ALLOWED_ENV_KEYS = [
  // User/Shell environment
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',

  // Locale settings
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_TERMINAL',
  'LC_TERMINAL_VERSION',

  // Terminal configuration
  'PATH',
  'TERM',
  'TERM_PROGRAM',
  'COLORTERM',

  // Editor preferences
  'EDITOR',
  'VISUAL',
  'PAGER',

  // XDG Base Directory specification
  'XDG_RUNTIME_DIR',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',

  // Temporary directories
  'TMPDIR',
  'TMP',
  'TEMP',
] as const;

/**
 * Creates a sanitized environment variable set for PTY processes
 * Filters process.env to include only whitelisted variables
 * Ensures TERM is set to xterm-256color for proper terminal support
 *
 * @returns Sanitized environment variables safe to pass to PTY
 */
export function sanitizeEnv(): Record<string, string> {
  const sanitized: Record<string, string> = {};

  // Iterate through allowed keys and copy from process.env if present
  for (const key of ALLOWED_ENV_KEYS) {
    const value = process.env[key];
    // Only include if the value is defined (process.env values can be undefined)
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }

  // Always set TERM to xterm-256color for consistent terminal support
  // This ensures the PTY has proper color and control sequence support
  sanitized.TERM = 'xterm-256color';

  return sanitized;
}
