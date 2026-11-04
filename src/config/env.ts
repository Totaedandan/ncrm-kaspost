import { z } from 'zod';
import { JOB_NAMES, type JobName } from '../application/job-runner';
import { DEFAULT_TRACK_CODE_PATTERN } from '../domain/track-code';
import { isTrackingStatus, type TrackingStatus } from '../domain/tracking-status';

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  );

const numericIds = csv.transform((parts, ctx) => {
  const ids = parts.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id))) {
    ctx.addIssue({ code: 'custom', message: 'must be a comma-separated list of integers' });
    return z.NEVER;
  }
  return ids;
});

/** Comma-separated deal ids -> list of digit strings (ids can exceed what is comfortable as numbers in .env tooling). */
const numericIdList = csv.transform((parts, ctx): string[] => {
  if (parts.some((part) => !/^\d+$/.test(part))) {
    ctx.addIssue({ code: 'custom', message: 'must be a comma-separated list of deal ids (digits only)' });
    return z.NEVER;
  }
  return parts;
});

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/** Empty string (unset in .env) -> null. */
const optionalPositiveInt = z
  .string()
  .default('')
  .transform((raw, ctx): number | null => {
    if (raw.trim() === '') return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      ctx.addIssue({ code: 'custom', message: 'must be a positive integer id' });
      return z.NEVER;
    }
    return value;
  });

const trackRegex = z
  .string()
  .default(DEFAULT_TRACK_CODE_PATTERN.source)
  .transform((source, ctx) => {
    try {
      return new RegExp(source);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a valid regular expression' });
      return z.NEVER;
    }
  });

const crmStatusMap = z
  .string()
  .default('{}')
  .transform((raw, ctx): Partial<Record<TrackingStatus, string>> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be valid JSON' });
      return z.NEVER;
    }
    const result = z.record(z.string(), z.string()).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({ code: 'custom', message: 'must be an object of string values' });
      return z.NEVER;
    }
    const map: Partial<Record<TrackingStatus, string>> = {};
    for (const [key, value] of Object.entries(result.data)) {
      if (!isTrackingStatus(key)) {
        ctx.addIssue({ code: 'custom', message: `unknown tracking status "${key}"` });
        return z.NEVER;
      }
      map[key] = value;
    }
    return map;
  });

/** Comma-separated job names to run once right after startup, in the given order. */
const jobNameList = csv.transform((parts, ctx): JobName[] => {
  const names: JobName[] = [];
  for (const part of parts) {
    const name = JOB_NAMES.find((candidate) => candidate === part);
    if (name === undefined) {
      ctx.addIssue({ code: 'custom', message: `unknown job "${part}" (known: ${JOB_NAMES.join(', ')})` });
      return z.NEVER;
    }
    names.push(name);
  }
  return names;
});

/** Comma-separated tracking statuses; an empty value means `fallback`. */
const trackingStatusList = (fallback: string) =>
  z
    .string()
    .default('')
    .transform((raw, ctx): TrackingStatus[] => {
      const statuses: TrackingStatus[] = [];
      const source = raw.trim() === '' ? fallback : raw;
      for (const part of source.split(',').map((p) => p.trim()).filter((p) => p !== '')) {
        if (!isTrackingStatus(part)) {
          ctx.addIssue({ code: 'custom', message: `unknown tracking status "${part}"` });
          return z.NEVER;
        }
        statuses.push(part);
      }
      return statuses;
    });

/** Statuses that produce their own Telegram message by default; everything else is covered by the summary after each poll. */
const DEFAULT_NOTIFY_STATUSES = 'DELIVERED';

const boolFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: positiveInt(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().min(1),
    TZ_REPORTS: z.string().default('Asia/Almaty'),

    CRM_DRIVER: z.enum(['mock', 'ncrm']).default('mock'),
    NCRM_BASE_URL: z.string().default(''),
    NCRM_API_KEY: z.string().default(''),
    NCRM_KAZPOST_DELIVERY_VALUE: z.string().default(''),
    /** Where the track code lives: in the deal's comments (default) or in a custom field. */
    NCRM_TRACK_SOURCE: z.enum(['comments', 'field']).default('comments'),
    NCRM_TRACK_FIELD_ID: optionalPositiveInt,
    NCRM_DELIVERY_FIELD_ID: optionalPositiveInt,
    /** Pilot: track only these deal ids (comma separated). Empty = every deal of the source stage. */
    NCRM_ONLY_DEAL_IDS: numericIdList,
    /** Stage ("НА ДОСТАВКЕ") whose deals are tracked; deals are moved only while they are still in it. */
    NCRM_SOURCE_STAGE_ID: optionalPositiveInt,
    CRM_STATUS_MAP: crmStatusMap,
    CRM_ADD_COMMENT: boolFlag,

    KAZPOST_BASE_URL: z.string().url().default('https://track.kazpost.kz/api/v2'),
    KAZPOST_CONCURRENCY: positiveInt(3),
    KAZPOST_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(300),
    TRACK_CODE_REGEX: trackRegex,
    /** Jobs to run once at startup, e.g. "sync-crm,poll-tracking,push-crm" (the cron schedule keeps running as usual). */
    RUN_ON_START: jobNameList,
    /** When the Kazpost poll (and the report that follows it) runs, in TZ_REPORTS time: once a day at 08:00 Almaty. */
    POLL_CRON: z.string().default('0 8 * * *'),
    /** Upper bound of shipments checked in one poll run. */
    POLL_BATCH_SIZE: positiveInt(1000),
    /** /health turns 503 when poll-tracking has not succeeded for this many hours (poll gap + slack). */
    HEALTH_POLL_STALE_HOURS: positiveInt(26),

    STUCK_IN_OFFICE_DAYS: positiveInt(5),
    NO_UPDATES_DAYS: positiveInt(10),

    TELEGRAM_BOT_TOKEN: z.string().default(''),
    /** polling = the service asks Telegram for updates (no public URL needed); webhook = Telegram calls us. */
    TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
    /** Statuses that are sent to the report chats as they happen; the daily report covers the rest. */
    TELEGRAM_NOTIFY_STATUSES: trackingStatusList(DEFAULT_NOTIFY_STATUSES),
    TELEGRAM_WEBHOOK_SECRET: z
      .string()
      .regex(/^[A-Za-z0-9_-]{0,256}$/, 'only A-Z a-z 0-9 _ - allowed')
      .default(''),
    TELEGRAM_PUBLIC_URL: z.string().default(''),
    TELEGRAM_REPORT_CHAT_IDS: csv,
    TELEGRAM_DEV_CHAT_ID: z.string().default(''),
    TELEGRAM_ADMIN_IDS: numericIds,
  })
  .superRefine((env, ctx) => {
    const require = (key: keyof typeof env, when: string): void => {
      const value = env[key];
      if (value === '' || (Array.isArray(value) && value.length === 0)) {
        ctx.addIssue({ code: 'custom', path: [key], message: `required when ${when}` });
      }
    };
    if (env.CRM_DRIVER === 'ncrm') {
      require('NCRM_BASE_URL', 'CRM_DRIVER=ncrm');
      require('NCRM_API_KEY', 'CRM_DRIVER=ncrm');
      if (env.NCRM_SOURCE_STAGE_ID === null) {
        ctx.addIssue({ code: 'custom', path: ['NCRM_SOURCE_STAGE_ID'], message: 'required when CRM_DRIVER=ncrm (see `pnpm ncrm:inspect`)' });
      }
      if (env.NCRM_TRACK_SOURCE === 'field' && env.NCRM_TRACK_FIELD_ID === null) {
        ctx.addIssue({ code: 'custom', path: ['NCRM_TRACK_FIELD_ID'], message: 'required when NCRM_TRACK_SOURCE=field (see `pnpm ncrm:inspect`)' });
      }
      if ((env.CRM_STATUS_MAP.DELIVERED ?? '') === '') {
        ctx.addIssue({ code: 'custom', path: ['CRM_STATUS_MAP'], message: 'DELIVERED must map to the "УСПЕШНО ДОСТАВЛЕН" stage id when CRM_DRIVER=ncrm' });
      }
    }
    if (env.NCRM_KAZPOST_DELIVERY_VALUE !== '' && env.NCRM_DELIVERY_FIELD_ID === null) {
      ctx.addIssue({ code: 'custom', path: ['NCRM_DELIVERY_FIELD_ID'], message: 'required when NCRM_KAZPOST_DELIVERY_VALUE is set' });
    }
    if (env.TELEGRAM_BOT_TOKEN !== '' && env.TELEGRAM_MODE === 'webhook') {
      require('TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_MODE=webhook');
      require('TELEGRAM_PUBLIC_URL', 'TELEGRAM_MODE=webhook');
    }
    if (env.NODE_ENV === 'production') {
      require('TELEGRAM_BOT_TOKEN', 'NODE_ENV=production');
    }
  });

export type Env = z.infer<typeof schema>;

export class EnvError extends Error {}

/** Parses and validates the environment. Throws EnvError listing every problem (fail fast). */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
  throw new EnvError(`Invalid environment:\n  ${problems.join('\n  ')}`);
}
