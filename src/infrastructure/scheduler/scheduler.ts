import { Cron } from 'croner';
import type { JobName, JobRunner } from '../../application/job-runner';
import type { Logger } from '../../shared/logger';

export interface ScheduledJob {
  name: JobName;
  cron: string;
  timezone?: string;
  run: (logger: Logger) => Promise<unknown>;
}

/** Cron triggers only. Locking, logging and bookkeeping happen in JobRunner. */
export class Scheduler {
  private readonly crons: Cron[] = [];
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly runner: JobRunner,
    private readonly jobs: readonly ScheduledJob[],
    private readonly logger: Logger,
  ) {}

  start(): void {
    for (const job of this.jobs) {
      const cron = new Cron(
        job.cron,
        { timezone: job.timezone, protect: true, name: job.name },
        () => void this.trigger(job),
      );
      this.crons.push(cron);
      this.logger.info({ job: job.name, cron: job.cron }, 'job scheduled');
    }
  }

  /** Runs a job now (also used by tests and manual triggers). */
  trigger(job: ScheduledJob): Promise<unknown> {
    const running = this.runner.run(job.name, job.run).finally(() => this.inFlight.delete(running));
    this.inFlight.add(running);
    return running;
  }

  /** Stops scheduling and waits for running jobs, but no longer than `timeoutMs`. */
  async stop(timeoutMs: number): Promise<{ timedOut: boolean }> {
    for (const cron of this.crons) cron.stop();
    if (this.inFlight.size === 0) return { timedOut: false };

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([Promise.allSettled([...this.inFlight]), timeout]);
    clearTimeout(timer);
    return { timedOut: outcome === 'timeout' };
  }
}
