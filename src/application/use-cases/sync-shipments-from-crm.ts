import { decideKazpostOrder, type KazpostFilterConfig } from '../../domain/kazpost-filter';
import { newShipment, resetForNewTrack, type Shipment } from '../../domain/shipment';
import type { Logger } from '../../shared/logger';
import type { CrmPort } from '../ports/crm.port';
import type {
  ShipmentRepository,
  SyncStateRepository,
  TransactionRunner,
} from '../ports/repositories';

export const CRM_CURSOR_KEY = 'ncrm.orders.cursor';

export interface SyncResult {
  seen: number;
  created: number;
  trackChanged: number;
  skipped: number;
}

export interface SyncShipmentsDeps {
  crm: CrmPort;
  shipments: ShipmentRepository;
  syncState: SyncStateRepository;
  tx: TransactionRunner;
  logger: Logger;
  filter: KazpostFilterConfig;
}

/**
 * Pulls changed orders from the CRM, keeps only Kazpost orders with a valid track code
 * and upserts them as shipments. The cursor moves only after the whole batch succeeded.
 */
export class SyncShipmentsFromCrm {
  constructor(private readonly deps: SyncShipmentsDeps) {}

  async execute(): Promise<SyncResult> {
    const { crm, syncState, logger, filter } = this.deps;
    const cursor = await syncState.get(CRM_CURSOR_KEY);
    const result = { seen: 0, created: 0, trackChanged: 0, skipped: 0 };
    let newestUpdate: Date | null = cursor !== null ? new Date(cursor) : null;

    for await (const page of crm.listOrdersUpdatedSince(cursor)) {
      for (const order of page.orders) {
        result.seen += 1;
        if (newestUpdate === null || order.updatedAt > newestUpdate) newestUpdate = order.updatedAt;

        const decision = decideKazpostOrder(order, filter);
        if (decision.kind === 'skip') {
          result.skipped += 1;
          if (decision.reason === 'INVALID_TRACK') {
            logger.warn({ orderId: order.id, track: order.trackCode }, 'invalid track code, order ignored');
          }
          continue;
        }

        const outcome = await this.upsert(order.id, decision.trackCode.value, order.customerName ?? null);
        if (outcome === 'created') result.created += 1;
        else if (outcome === 'track_changed') result.trackChanged += 1;
        else if (outcome === 'conflict') result.skipped += 1;
      }
    }

    if (newestUpdate !== null) await syncState.set(CRM_CURSOR_KEY, newestUpdate.toISOString());
    logger.info(result, 'crm sync finished');
    return result;
  }

  private async upsert(
    crmOrderId: string,
    trackCode: string,
    customerName: string | null,
  ): Promise<'created' | 'track_changed' | 'updated' | 'unchanged' | 'conflict'> {
    const { shipments, tx, logger } = this.deps;
    const existing = await shipments.findByCrmOrderId(crmOrderId);

    const owner = await shipments.findByTrackCode(trackCode);
    if (owner !== null && owner.crmOrderId !== crmOrderId) {
      logger.warn({ crmOrderId, trackCode, ownerOrderId: owner.crmOrderId }, 'track code already used by another order');
      return 'conflict';
    }

    if (existing === null) {
      await shipments.create(newShipment({ crmOrderId, trackCode, customerName }));
      return 'created';
    }

    if (existing.trackCode !== trackCode) {
      const reset = resetForNewTrack(existing, trackCode);
      await tx.run(async (repos) => {
        await repos.events.deleteForShipment(existing.id);
        await repos.shipments.save({ ...reset, customerName });
      });
      return 'track_changed';
    }

    if (existing.customerName !== customerName) {
      const updated: Shipment = { ...existing, customerName };
      await shipments.save(updated);
      return 'updated';
    }
    return 'unchanged';
  }
}
