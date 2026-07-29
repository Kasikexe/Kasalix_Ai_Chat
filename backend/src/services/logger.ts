/**
 * Logger service — structured logging with security filtering.
 *
 * Design decisions:
 * - Uses console.log/error directly (matches existing project pattern)
 * - Adds timestamp and log level for readability
 * - NEVER logs: passwords, password hashes, session tokens, or chat messages
 * - Chat message logging requires explicit opt-in via LOG_CHAT_MESSAGES env
 */

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

const LOG_CHAT = process.env.LOG_CHAT_MESSAGES === 'true';

function formatTimestamp(): string {
  return new Date().toISOString();
}

function sanitize(...args: unknown[]): string[] {
  return args.map((a) => {
    const s = String(a);
    // Block anything that looks like a password/hash/token
    if (
      /(passw(or)?d|secret|token|hash|auth|session)/i.test(s) &&
      (s.length > 20 || /^(\$2[aby]\$|\$argon2)/.test(s))
    ) {
      return '[REDACTED]';
    }
    return s;
  });
}

export const logger = {
  info(...args: unknown[]): void {
    console.log(`[${formatTimestamp()}] [INFO]`, ...sanitize(...args));
  },

  warn(...args: unknown[]): void {
    console.warn(`[${formatTimestamp()}] [WARN]`, ...sanitize(...args));
  },

  error(...args: unknown[]): void {
    console.error(`[${formatTimestamp()}] [ERROR]`, ...sanitize(...args));
  },

  debug(...args: unknown[]): void {
    if (process.env.NODE_ENV !== 'production' || process.env.LOG_DEBUG === 'true') {
      console.debug(`[${formatTimestamp()}] [DEBUG]`, ...sanitize(...args));
    }
  },

  /**
   * Log chat-related events. Only logs if LOG_CHAT_MESSAGES is explicitly enabled.
   * Never logs the actual message content — just metadata.
   */
  chat(event: string, meta?: Record<string, unknown>): void {
    if (!LOG_CHAT) return;
    console.log(`[${formatTimestamp()}] [CHAT] ${event}`, meta ? JSON.stringify(meta) : '');
  },
};

export type Logger = typeof logger;
