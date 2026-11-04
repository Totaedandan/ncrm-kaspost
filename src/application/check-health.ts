import type { Clock } from '../shared/clock';
import { JOB_NAMES, lastSuccessKey } from './job-runner';
import type { HealthProbe, SyncStateRepository } from './ports/repositories';

const HOUR_MS = 60 * 60 * 1000;
/** Poll runs twice a day (12 h apart) plus an hour of slack. */
export const DEFAULT_POLL_STALE_AFTER_MS = 13 * HOUR_MS;

export interface HealthReport {
  ok: boolean;
  database: boolean;
  jobs: Record<string, string | null>;
  problems: string[];
}

export interface CheckHealthDeps {
  probe: HealthProbe;
  syncState: SyncStateRepository;
  clock: Clock;
  startedAt: Date;
  /** How long poll-tracking may go without a success before /health turns 503. */
  pollStaleAfterMs?: number;
}

export class CheckHealth {
  constructor(private readonly deps: CheckHealthDeps) {}

  async execute(): Promise<HealthReport> {
    const { probe, syncState, clock, startedAt } = this.deps;
    const staleAfterMs = this.deps.pollStaleAfterMs ?? DEFAULT_POLL_STALE_AFTER_MS;
    const problems: string[] = [];

    const database = await probe.ping().then(
      () => true,
      () => false,
    );
    if (!database) problems.push('database unreachable');

    const jobs: Record<string, string | null> = {};
    if (database) {
      for (const name of JOB_NAMES) jobs[name] = await syncState.get(lastSuccessKey(name));
    }

    const now = clock.now().getTime();
    const lastPoll = jobs['poll-tracking'] ?? null;
    const reference = lastPoll !== null ? new Date(lastPoll).getTime() : startedAt.getTime();
    if (database && now - reference > staleAfterMs) {
      problems.push(`poll-tracking has not succeeded for more than ${Math.round(staleAfterMs / HOUR_MS)} hours`);
    }

    return { ok: problems.length === 0, database, jobs, problems };
  }
}
