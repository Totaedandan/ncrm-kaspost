import { pino, type Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  level: string;
  pretty?: boolean;
}

/** Paths whose values must never reach the logs. */
const REDACTED_PATHS = [
  'token',
  'apiKey',
  'secret',
  'authorization',
  '*.token',
  '*.apiKey',
  '*.secret',
  '*.authorization',
  'headers.authorization',
  'headers["x-telegram-bot-api-secret-token"]',
];

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    ...(options.pretty ? { transport: { target: 'pino-pretty' } } : {}),
  });
}

export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
