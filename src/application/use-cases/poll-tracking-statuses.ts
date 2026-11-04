import { createHash } from 'node:crypto';
import { ExternalSchemaError } from '../../domain/errors';
import type { OutboxEntry, ShipmentRef } from '../../domain/notification';
import { applyObservation, applyPollFailure, type Shipment } from '../../domain/shipment';
import type { TrackingEvent } from '../../domain/tracking-event';
import type { TrackingStatus } from '../../domain/tracking-status';
import { createLimiter, createRateGate } from '../../shared/concurrency';
import type { Clock } from '../../shared/clock';
import type { Logger } from '../../shared/logger';
import { devAlertEntry, errorMessage, hourBucket } from '../dev-alert';
import type {
  OutboxRepository,
  ShipmentRepository,
  TransactionRunner,
} from '../ports/repositories';
import type { TrackingPort } from '../ports/tracking.port';

const OUTAGE_ALERT_THRESHOLD = 3;

export interface PollConfig {
  batchSize: number;
  concurrency: number;
  minIntervalMs: number;
  /** Statuses that are announced to the business; other transitions are tracked and pushed to the CRM, but silent. */
  notifyStatuses: readonly TrackingStatus[];
}

export interface PollDeps {
  tracking: TrackingPort;
  shipments: ShipmentRepository;
  outbox: OutboxRepository;
  tx: TransactionRunner;
  clock: Clock;
  logger: Logger;
  config: PollConfig;
}

export interface PollResult {
  polled: number;
  statusChanges: number;
  failures: number;
  schemaErrors: number;
  /** Deals that became DELIVERED in this very run (exact, unlike a time window over the database). */
  delivered: ShipmentRef[];
  /** Deals that turned out to be on their way back to the sender in this run. */
  returned: ShipmentRef[];
}

type PollOutcome =
  | { kind: 'changed'; shipment: Shipment }
  | { kind: 'unchanged' | 'failed' | 'schema' };

/**
 * Polls every non-terminal shipment (the schedule itself decides how often: twice a day by default).
 * On a status transition one transaction updates the shipment, marks the CRM sync as PENDING
 * and writes the notification to the outbox. `batchSize` caps one run; the least recently
 * checked shipments go first, so a cap smaller than the backlog still rotates through everything.
 */
export class PollTrackingStatuses {
  constructor(private readonly deps: PollDeps) {}

  async execute(): Promise<PollResult> {
    const { shipments, config } = this.deps;
    const due = await shipments.findActiveForPolling(config.batchSize);
    const limit = createLimiter(config.concurrency);
    const gate = createRateGate(config.minIntervalMs);

    const outcomes = await Promise.all(
      due.map((shipment) =>
        limit(async () => {
          await gate();
          return this.pollOne(shipment);
        }),
      ),
    );

    const changed = outcomes.flatMap((o) => (o.kind === 'changed' ? [o.shipment] : []));
    const result: PollResult = {
      polled: due.length,
      statusChanges: changed.length,
      failures: outcomes.filter((o) => o.kind === 'failed').length,
      schemaErrors: outcomes.filter((o) => o.kind === 'schema').length,
      delivered: changed.filter((s) => s.status === 'DELIVERED').map(toRef),
      returned: changed.filter((s) => s.status === 'RETURNED').map(toRef),
    };
    await this.alertOnOutage(result);
    return result;
  }

  private async pollOne(shipment: Shipment): Promise<PollOutcome> {
    const { tracking, logger, clock } = this.deps;
    let events: TrackingEvent[];
    try {
      events = await tracking.fetchEvents(shipment.trackCode);
    } catch (error) {
      const isSchema = error instanceof ExternalSchemaError;
      logger.warn({ track: shipment.trackCode, err: errorMessage(error) }, 'tracking request failed');
      await this.recordFailure(shipment, error);
      return { kind: isSchema ? 'schema' : 'failed' };
    }

    try {
      return await this.recordObservation(shipment, events, clock.now());
    } catch (error) {
      logger.error({ track: shipment.trackCode, err: errorMessage(error) }, 'failed to persist tracking result');
      return { kind: 'failed' };
    }
  }

  private async recordFailure(shipment: Shipment, error: unknown): Promise<void> {
    const { tx, clock } = this.deps;
    const now = clock.now();
    const alerts: OutboxEntry[] =
      error instanceof ExternalSchemaError
        ? [
            devAlertEntry(
              `dev:schema:${shipment.trackCode}:${now.toISOString().slice(0, 10)}`,
              'Kazpost: ответ не совпал со схемой',
              `${shipment.trackCode}\n${error.message}\n${error.sample}`,
            ),
          ]
        : [];
    await tx.run(async (repos) => {
      await repos.shipments.save(applyPollFailure(shipment, now));
      for (const alert of alerts) await repos.outbox.enqueue(alert);
    });
  }

  private recordObservation(
    shipment: Shipment,
    events: readonly TrackingEvent[],
    now: Date,
  ): Promise<PollOutcome> {
    const observation = applyObservation(shipment, events, now);

    return this.deps.tx.run(async (repos) => {
      const fresh = await repos.events.insertNew(shipment.id, shipment.trackCode, events);
      await repos.shipments.save(observation.shipment);

      for (const event of fresh) {
        if (event.status === 'UNKNOWN') {
          await repos.outbox.enqueue(unknownStatusAlert(shipment.trackCode, event));
        }
      }
      if (!observation.statusChanged) return { kind: 'unchanged' };

      const next = observation.shipment;
      if (next.status !== 'UNKNOWN' && this.deps.config.notifyStatuses.includes(next.status)) {
        await repos.outbox.enqueue(statusNotification(next));
      }
      return { kind: 'changed', shipment: next };
    });
  }

  private async alertOnOutage(result: PollResult): Promise<void> {
    if (result.failures < OUTAGE_ALERT_THRESHOLD || result.failures < result.polled - result.schemaErrors) {
      return;
    }
    const now = this.deps.clock.now();
    await this.deps.outbox.enqueue(
      devAlertEntry(
        `dev:kazpost-down:${hourBucket(now)}`,
        'Kazpost недоступна',
        `Все ${result.failures} запросов за прогон завершились ошибкой.`,
      ),
    );
  }
}

function toRef(shipment: Shipment): ShipmentRef {
  return {
    trackCode: shipment.trackCode,
    crmOrderId: shipment.crmOrderId,
    customerName: shipment.customerName,
  };
}

function statusNotification(shipment: Shipment): OutboxEntry {
  const payload = {
    trackCode: shipment.trackCode,
    crmOrderId: shipment.crmOrderId,
    customerName: shipment.customerName,
    status: shipment.status,
    rawStatus: shipment.rawStatus,
    location: shipment.lastLocation,
    occurredAt: (shipment.statusChangedAt ?? shipment.lastEventAt ?? shipment.createdAt).toISOString(),
  };
  const dedupKey = `${shipment.id}:${shipment.status}`;
  return shipment.status === 'DELIVERED'
    ? { type: 'DELIVERED', dedupKey, payload }
    : { type: 'STATUS_CHANGED', dedupKey, payload };
}

function unknownStatusAlert(trackCode: string, event: TrackingEvent): OutboxEntry {
  const digest = createHash('sha1').update(event.rawStatus.trim().toLowerCase()).digest('hex');
  return devAlertEntry(
    `dev:unknown-status:${digest}`,
    'Kazpost: неизвестный статус',
    `Трек ${trackCode}\nraw: "${event.rawStatus}"\nДобавьте правило в kazpost-status.mapper.ts`,
  );
}
