import type { Shipment } from '../../domain/shipment';
import type { TrackingStatus } from '../../domain/tracking-status';
import type { Clock } from '../../shared/clock';
import type { Logger } from '../../shared/logger';
import { devAlertEntry, errorMessage, hourBucket } from '../dev-alert';
import type { CrmPort } from '../ports/crm.port';
import type { OutboxRepository, ShipmentRepository } from '../ports/repositories';

export const MAX_CRM_SYNC_ATTEMPTS = 5;
const BATCH_LIMIT = 100;
const OUTAGE_ALERT_THRESHOLD = 3;

export type CrmStatusMap = Partial<Record<TrackingStatus, string>>;

export interface PushStatusDeps {
  crm: CrmPort;
  shipments: ShipmentRepository;
  outbox: OutboxRepository;
  clock: Clock;
  logger: Logger;
  /** Internal status -> CRM stage id. Missing or empty entries are never pushed. */
  statusMap: CrmStatusMap;
  addComment: boolean;
  /**
   * When set, an order is moved only while it is still in this CRM status (e.g. the "НА ДОСТАВКЕ" stage):
   * if a manager has moved the deal elsewhere, the automatic update is skipped.
   */
  requiredCurrentStatus?: string | null;
}

export interface PushResult {
  pushed: number;
  skipped: number;
  failed: number;
}

export class PushStatusToCrm {
  constructor(private readonly deps: PushStatusDeps) {}

  async execute(): Promise<PushResult> {
    const { shipments } = this.deps;
    const pending = await shipments.findPendingCrmSync(MAX_CRM_SYNC_ATTEMPTS, BATCH_LIMIT);
    const result = { pushed: 0, skipped: 0, failed: 0 };

    for (const shipment of pending) {
      const outcome = await this.pushOne(shipment);
      result[outcome] += 1;
    }

    if (result.failed >= OUTAGE_ALERT_THRESHOLD && result.pushed === 0) {
      await this.deps.outbox.enqueue(
        devAlertEntry(
          `dev:crm-down:${hourBucket(this.deps.clock.now())}`,
          'NCRM недоступна',
          `${result.failed} обновлений заказов не удалось отправить за прогон.`,
        ),
      );
    }
    return result;
  }

  private async pushOne(shipment: Shipment): Promise<'pushed' | 'skipped' | 'failed'> {
    const { crm, shipments, logger } = this.deps;
    const crmStatusId = this.deps.statusMap[shipment.status];
    if (crmStatusId === undefined || crmStatusId === '') {
      await shipments.markCrmSynced(shipment.id, shipment.status);
      return 'skipped';
    }

    try {
      if (!(await this.isInRequiredStatus(shipment))) {
        await shipments.markCrmSynced(shipment.id, shipment.status);
        logger.info({ orderId: shipment.crmOrderId, status: shipment.status }, 'order is not in the source status any more, crm not updated');
        return 'skipped';
      }
      await crm.updateOrderStatus(shipment.crmOrderId, crmStatusId);
    } catch (error) {
      return this.handleFailure(shipment, error);
    }

    await this.tryComment(shipment);
    await shipments.markCrmSynced(shipment.id, shipment.status);
    logger.info({ orderId: shipment.crmOrderId, status: shipment.status }, 'crm status updated');
    return 'pushed';
  }

  private async isInRequiredStatus(shipment: Shipment): Promise<boolean> {
    const required = this.deps.requiredCurrentStatus ?? null;
    if (required === null) return true;
    return (await this.deps.crm.getOrderStatus(shipment.crmOrderId)) === required;
  }

  private async handleFailure(shipment: Shipment, error: unknown): Promise<'failed'> {
    const { shipments, outbox, logger } = this.deps;
    logger.warn({ orderId: shipment.crmOrderId, err: errorMessage(error) }, 'crm status update failed');
    const attempts = await shipments.markCrmFailed(shipment.id, shipment.status);
    if (attempts !== null && attempts >= MAX_CRM_SYNC_ATTEMPTS) {
      await outbox.enqueue(
        devAlertEntry(
          `dev:crm-push-failed:${shipment.id}:${shipment.status}`,
          'NCRM: статус заказа не обновлён',
          `Заказ ${shipment.crmOrderId}, трек ${shipment.trackCode}, статус ${shipment.status}\n${errorMessage(error)}`,
        ),
      );
    }
    return 'failed';
  }

  /** Comments are best-effort: a failed comment must not block the status sync. */
  private async tryComment(shipment: Shipment): Promise<void> {
    const { crm, addComment, logger } = this.deps;
    if (!addComment) return;
    try {
      await crm.addOrderComment(shipment.crmOrderId, commentText(shipment));
    } catch (error) {
      logger.warn({ orderId: shipment.crmOrderId, err: errorMessage(error) }, 'crm comment failed');
    }
  }
}

function commentText(shipment: Shipment): string {
  const when = (shipment.statusChangedAt ?? shipment.lastEventAt)?.toISOString() ?? '';
  const parts = [shipment.rawStatus ?? shipment.status, shipment.lastLocation, when].filter(
    (part): part is string => part !== null && part !== '',
  );
  return `Казпочта: ${parts.join(', ')}`;
}
