import type { Shipment } from '../../domain/shipment';
import { evaluateStuck, type StuckConfig, type StuckVerdict } from '../../domain/stuck';
import type { Clock } from '../../shared/clock';
import type { TransactionRunner, ShipmentRepository } from '../ports/repositories';

export interface StuckShipment {
  shipment: Shipment;
  verdict: StuckVerdict;
}

export interface DetectStuckDeps {
  shipments: ShipmentRepository;
  tx: TransactionRunner;
  clock: Clock;
  config: StuckConfig;
}

export class DetectStuckShipments {
  constructor(private readonly deps: DetectStuckDeps) {}

  /** Read-only: everything that is stuck right now, alerted or not (used by /stuck and the report). */
  async listStuck(): Promise<StuckShipment[]> {
    const { shipments, clock, config } = this.deps;
    const now = clock.now();
    const active = await shipments.findActive();
    return active.flatMap((shipment) => {
      const verdict = evaluateStuck(shipment, now, config);
      return verdict === null ? [] : [{ shipment, verdict }];
    });
  }

  /** Alerts once per shipment: the flag and the outbox entry are written in one transaction. */
  async execute(): Promise<{ alerted: number }> {
    const { shipments, tx, clock, config } = this.deps;
    const now = clock.now();
    const candidates = await shipments.findActiveWithoutStuckAlert();
    let alerted = 0;

    for (const shipment of candidates) {
      const verdict = evaluateStuck(shipment, now, config);
      if (verdict === null) continue;

      await tx.run(async (repos) => {
        await repos.outbox.enqueue({
          type: 'STUCK',
          dedupKey: `stuck:${shipment.id}`,
          payload: {
            trackCode: shipment.trackCode,
            crmOrderId: shipment.crmOrderId,
            customerName: shipment.customerName,
            reason: verdict.reason,
            days: verdict.days,
            location: shipment.lastLocation,
          },
        });
        await repos.shipments.save({ ...shipment, stuckAlertSentAt: now });
      });
      alerted += 1;
    }
    return { alerted };
  }
}
