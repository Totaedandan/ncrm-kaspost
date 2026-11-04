import { randomUUID } from 'node:crypto';
import type { Clock } from '../shared/clock';
import type { Logger } from '../shared/logger';
import { devAlertEntry, errorMessage, hourBucket } from './dev-alert';
import type { JobLockPort, OutboxRepository, SyncStateRepository } from './ports/repositories';

export const JOB_NAMES = [
  'sync-crm',
  'poll-tracking',
  'push-crm',
  'dispatch-notifications',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export const lastSuccessKey = (job: string): string => `job.${job}.lastSuccessAt`;

export type JobOutcome = 'ok' | 'skipped' | 'failed';

export interface JobRunnerDeps {
  lock: JobLockPort;
  syncState: SyncStateRepository;
  outbox: OutboxRepository;
  clock: Clock;
  logger: Logger;
  newCorrelationId?: () => string;
}

/**
 * Wraps every scheduled run: advisory lock (no parallel runs across instances),
 * correlationId logging, last-success bookkeeping for /health, developer alert on crashes.
 */
export class JobRunner {
  constructor(private readonly deps: JobRunnerDeps) {}

  async run(name: JobName, work: (logger: Logger) => Promise<unknown>): Promise<JobOutcome> {
    const { lock, clock } = this.deps;
    const correlationId = (this.deps.newCorrelationId ?? randomUUID)();
    const logger = this.deps.logger.child({ job: name, correlationId });

    const handle = await lock.tryAcquire(name);
    if (handle === null) {
      logger.info('job already running elsewhere, skipping');
      return 'skipped';
    }

    try {
      await work(logger);
      await this.deps.syncState.set(lastSuccessKey(name), clock.now().toISOString());
      return 'ok';
    } catch (error) {
      logger.error({ err: errorMessage(error) }, 'job failed');
      await this.alertFailure(name, error, logger);
      return 'failed';
    } finally {
      await handle.release();
    }
  }

  private async alertFailure(name: JobName, error: unknown, logger: Logger): Promise<void> {
    const { outbox, clock } = this.deps;
    try {
      await outbox.enqueue(
        devAlertEntry(
          `dev:job-error:${name}:${hourBucket(clock.now())}`,
          `Джоб ${name} упал`,
          errorMessage(error),
        ),
      );
    } catch (alertError) {
      logger.error({ err: errorMessage(alertError) }, 'could not enqueue failure alert');
    }
  }
}
