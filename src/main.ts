import { CheckHealth } from './application/check-health';
import { JobRunner } from './application/job-runner';
import type { CrmPort } from './application/ports/crm.port';
import type { NotifierPort } from './application/ports/notifier.port';
import { BuildDailyReport } from './application/use-cases/build-daily-report';
import { DetectStuckShipments } from './application/use-cases/detect-stuck-shipments';
import { DispatchNotifications } from './application/use-cases/dispatch-notifications';
import { PollTrackingStatuses } from './application/use-cases/poll-tracking-statuses';
import { PushStatusToCrm } from './application/use-cases/push-status-to-crm';
import { SyncShipmentsFromCrm } from './application/use-cases/sync-shipments-from-crm';
import { loadEnv, type Env } from './config/env';
import { MockCrmAdapter } from './infrastructure/crm/mock-crm.adapter';
import { NcrmAdapter } from './infrastructure/crm/ncrm.adapter';
import { createPrismaClient, PrismaHealthProbe } from './infrastructure/db/prisma';
import { PrismaOutboxRepository } from './infrastructure/db/repositories/outbox.repository';
import { PrismaShipmentRepository } from './infrastructure/db/repositories/shipment.repository';
import { PrismaSyncStateRepository } from './infrastructure/db/repositories/sync-state.repository';
import { PrismaTrackingEventRepository } from './infrastructure/db/repositories/tracking-event.repository';
import { PrismaTransactionRunner } from './infrastructure/db/repositories/transaction-runner';
import { HttpClient } from './infrastructure/http/http-client';
import { buildServer } from './infrastructure/http/server';
import { PgAdvisoryLock } from './infrastructure/scheduler/advisory-lock';
import { Scheduler, type ScheduledJob } from './infrastructure/scheduler/scheduler';
import type { Bot } from 'grammy';
import { commandMenu, createBot } from './infrastructure/telegram/bot';
import { LogNotifier } from './infrastructure/telegram/log.notifier';
import { startPolling, type PollingHandle } from './infrastructure/telegram/polling';
import { TelegramNotifier } from './infrastructure/telegram/telegram.notifier';
import { KazpostAdapter } from './infrastructure/tracking/kazpost.adapter';
import { systemClock } from './shared/clock';
import { createLogger, type Logger } from './shared/logger';

const SHUTDOWN_GRACE_MS = 25_000;
const USER_AGENT = 'ncrm-kazpost-tracker/0.1';

/** The mock CRM has no stages, so the stage guard only applies to NCRM. */
function sourceStageOf(env: Env): string | null {
  return env.CRM_DRIVER === 'ncrm' && env.NCRM_SOURCE_STAGE_ID !== null ? String(env.NCRM_SOURCE_STAGE_ID) : null;
}

function createCrm(env: Env): CrmPort {
  if (env.CRM_DRIVER === 'mock') return new MockCrmAdapter();
  return new NcrmAdapter({
    baseUrl: env.NCRM_BASE_URL,
    apiKey: env.NCRM_API_KEY,
    trackFieldId: env.NCRM_TRACK_SOURCE === 'field' ? env.NCRM_TRACK_FIELD_ID : null,
    trackCommentPattern: env.NCRM_TRACK_SOURCE === 'comments' ? env.TRACK_CODE_REGEX : null,
    deliveryFieldId: env.NCRM_DELIVERY_FIELD_ID,
    sourceStageId: sourceStageOf(env),
    onlyOrderIds: env.NCRM_ONLY_DEAL_IDS.length === 0 ? null : new Set(env.NCRM_ONLY_DEAL_IDS),
    http: new HttpClient({ service: 'ncrm', userAgent: USER_AGENT }),
  });
}

/** Developer alerts go to the dedicated chat, or to the first admin's private chat when none is set. */
function devChatIdOf(env: Env): string {
  if (env.TELEGRAM_DEV_CHAT_ID !== '') return env.TELEGRAM_DEV_CHAT_ID;
  const firstAdmin = env.TELEGRAM_ADMIN_IDS[0];
  return firstAdmin === undefined ? '' : String(firstAdmin);
}

async function registerWebhook(bot: Bot, env: Env, logger: Logger): Promise<void> {
  const url = `${env.TELEGRAM_PUBLIC_URL.replace(/\/+$/, '')}/telegram/webhook/${env.TELEGRAM_WEBHOOK_SECRET}`;
  await bot.init();
  await bot.api
    .setWebhook(url, { secret_token: env.TELEGRAM_WEBHOOK_SECRET })
    .then(() => logger.info('telegram webhook registered'))
    .catch((error: unknown) => logger.error({ err: String(error) }, 'could not register telegram webhook'));
}

/** Runs the requested jobs one after another (each still goes through the lock and the job runner). */
async function runStartupJobs(
  names: readonly string[],
  jobs: readonly ScheduledJob[],
  scheduler: Scheduler,
  logger: Logger,
): Promise<void> {
  for (const name of names) {
    const job = jobs.find((candidate) => candidate.name === name);
    if (job === undefined) continue;
    logger.info({ job: name }, 'running job at startup');
    await scheduler.trigger(job);
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });
  const clock = systemClock;
  const startedAt = clock.now();

  const prisma = createPrismaClient(env.DATABASE_URL);
  const shipments = new PrismaShipmentRepository(prisma);
  const events = new PrismaTrackingEventRepository(prisma);
  const outbox = new PrismaOutboxRepository(prisma);
  const syncState = new PrismaSyncStateRepository(prisma);
  const tx = new PrismaTransactionRunner(prisma);

  const crm = createCrm(env);
  const tracking = new KazpostAdapter({
    baseUrl: env.KAZPOST_BASE_URL,
    http: new HttpClient({ service: 'kazpost', userAgent: USER_AGENT }),
  });

  const bot = env.TELEGRAM_BOT_TOKEN === '' ? null : createBot({
    token: env.TELEGRAM_BOT_TOKEN,
    adminIds: env.TELEGRAM_ADMIN_IDS,
    timeZone: env.TZ_REPORTS,
    trackPattern: env.TRACK_CODE_REGEX,
    logger,
    shipments,
    events,
    get buildReport() { return buildReport; },
    get detectStuck() { return detectStuck; },
    get checkHealth() { return checkHealth; },
  });
  const notifier: NotifierPort = bot
    ? new TelegramNotifier({
        sender: bot.api,
        reportChatIds: env.TELEGRAM_REPORT_CHAT_IDS,
        devChatId: devChatIdOf(env),
        timeZone: env.TZ_REPORTS,
        logger,
      })
    : new LogNotifier(logger);

  const stuckConfig = { stuckInOfficeDays: env.STUCK_IN_OFFICE_DAYS, noUpdatesDays: env.NO_UPDATES_DAYS };
  const detectStuck = new DetectStuckShipments({ shipments, tx, clock, config: stuckConfig });
  const buildReport = new BuildDailyReport({
    shipments,
    outbox,
    detectStuck,
    clock,
  });
  const checkHealth = new CheckHealth({
    probe: new PrismaHealthProbe(prisma),
    syncState,
    clock,
    startedAt,
    pollStaleAfterMs: env.HEALTH_POLL_STALE_HOURS * 3_600_000,
  });

  const syncCrm = new SyncShipmentsFromCrm({
    crm, shipments, syncState, tx, logger,
    filter: { deliveryValue: env.NCRM_KAZPOST_DELIVERY_VALUE, trackPattern: env.TRACK_CODE_REGEX },
  });
  const poll = new PollTrackingStatuses({
    tracking, shipments, outbox, tx, clock, logger,
    config: {
      batchSize: env.POLL_BATCH_SIZE,
      concurrency: env.KAZPOST_CONCURRENCY,
      minIntervalMs: env.KAZPOST_MIN_INTERVAL_MS,
      notifyStatuses: env.TELEGRAM_NOTIFY_STATUSES,
    },
  });
  const pushCrm = new PushStatusToCrm({
    crm, shipments, outbox, clock, logger,
    statusMap: env.CRM_STATUS_MAP,
    addComment: env.CRM_ADD_COMMENT,
    requiredCurrentStatus: sourceStageOf(env),
  });
  const dispatch = new DispatchNotifications({ notifier, outbox, clock, logger });

  const runner = new JobRunner({ lock: new PgAdvisoryLock(env.DATABASE_URL), syncState, outbox, clock, logger });
  const jobs: ScheduledJob[] = [
    { name: 'sync-crm', cron: '*/10 * * * *', run: () => syncCrm.execute() },
    { name: 'poll-tracking', cron: env.POLL_CRON, timezone: env.TZ_REPORTS, run: async () => {
        const result = await poll.execute();
        await buildReport.enqueuePollSummary(result);
        return result;
      },
    },
    { name: 'push-crm', cron: '*/2 * * * *', run: () => pushCrm.execute() },
    { name: 'dispatch-notifications', cron: '* * * * *', run: () => dispatch.execute() },
  ];
  const scheduler = new Scheduler(runner, jobs, logger);

  const server = buildServer({
    logger,
    checkHealth,
    telegram: bot && env.TELEGRAM_MODE === 'webhook' ? { bot, secret: env.TELEGRAM_WEBHOOK_SECRET } : undefined,
  });
  await server.listen({ port: env.PORT, host: '0.0.0.0' });

  let polling: PollingHandle | null = null;
  if (bot) {
    if (env.TELEGRAM_ADMIN_IDS.length === 0) {
      logger.warn('TELEGRAM_ADMIN_IDS is empty: the bot answers only /id until your id is added');
    }
    if (env.TELEGRAM_REPORT_CHAT_IDS.length === 0) {
      logger.warn('TELEGRAM_REPORT_CHAT_IDS is empty: status notifications and reports are dropped');
    }
    await bot.api
      .setMyCommands(commandMenu())
      .catch((error: unknown) => logger.warn({ err: String(error) }, 'could not set the telegram command menu'));

    if (env.TELEGRAM_MODE === 'webhook') {
      await registerWebhook(bot, env, logger);
    } else {
      polling = startPolling(bot, {
        logger,
        onFatal: (error) => {
          logger.fatal({ err: String(error) }, 'telegram polling cannot continue (bad token, or another instance uses this bot)');
          void shutdown('telegram-fatal', 1);
        },
      });
    }
  }

  scheduler.start();
  void runStartupJobs(env.RUN_ON_START, jobs, scheduler, logger);
  logger.info({ port: env.PORT, crm: env.CRM_DRIVER }, 'service started');

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    await polling?.stop();
    const { timedOut } = await scheduler.stop(SHUTDOWN_GRACE_MS);
    if (timedOut) logger.warn('jobs did not finish within the grace period');
    await server.close();
    await prisma.$disconnect();
    logger.info('shutdown complete');
    process.exit(exitCode);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // Logger may not exist yet (env validation failed), so write straight to stderr.
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
