import type { DailyReportPayload, ShipmentRef } from '../../domain/notification';
import type { Shipment } from '../../domain/shipment';
import type { TrackingStatus } from '../../domain/tracking-status';
import type { Clock } from '../../shared/clock';
import { hourBucket } from '../dev-alert';
import type { OutboxRepository, ShipmentRepository } from '../ports/repositories';
import type { DetectStuckShipments } from './detect-stuck-shipments';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a poll run found; a subset of `PollResult`, so the report does not depend on the poll use case. */
export interface PollRunSummary {
  polled: number;
  delivered: ShipmentRef[];
  returned: ShipmentRef[];
}

export interface DailyReportDeps {
  shipments: ShipmentRepository;
  outbox: OutboxRepository;
  detectStuck: DetectStuckShipments;
  clock: Clock;
}

export class BuildDailyReport {
  constructor(private readonly deps: DailyReportDeps) {}

  /**
   * Computes the report without side effects (used by /report).
   * Without `run` the delivered/returned lists cover the last 24 hours; with the result of a poll run they list
   * exactly what that run found, so nothing is lost or repeated between two daily reports.
   */
  async build(run?: PollRunSummary): Promise<DailyReportPayload> {
    const { shipments, detectStuck, clock } = this.deps;
    const now = clock.now();
    const since = new Date(now.getTime() - DAY_MS);

    const recent = async (status: TrackingStatus): Promise<ShipmentRef[]> =>
      (await shipments.findByStatusChangedSince([status], since)).map(toRef);

    const [delivered, returns, active, stuck] = await Promise.all([
      run?.delivered ?? recent('DELIVERED'),
      run?.returned ?? recent('RETURNED'),
      shipments.findActive(),
      detectStuck.listStuck(),
    ]);

    return {
      generatedAt: now.toISOString(),
      ...(run === undefined ? {} : { checked: run.polled }),
      delivered,
      atOffice: active.filter((s) => s.status === 'ARRIVED_AT_OFFICE').map(toRef),
      stuck: stuck.map((s) => toRef(s.shipment)),
      returns,
    };
  }

  /** After the daily poll run: one summary message per hour at most, however often the poll is started. */
  async enqueuePollSummary(run: PollRunSummary): Promise<{ enqueued: boolean }> {
    const { outbox, clock } = this.deps;
    const payload = await this.build(run);
    const enqueued = await outbox.enqueue({
      type: 'DAILY_REPORT',
      dedupKey: `poll-report:${hourBucket(clock.now())}`,
      payload,
    });
    return { enqueued };
  }
}

function toRef(shipment: Shipment): ShipmentRef {
  return {
    trackCode: shipment.trackCode,
    crmOrderId: shipment.crmOrderId,
    customerName: shipment.customerName,
  };
}
