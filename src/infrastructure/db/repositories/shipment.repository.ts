import type { Prisma, PrismaClient, Shipment as ShipmentRow } from '@prisma/client';
import type { ShipmentRepository } from '../../../application/ports/repositories';
import type { NewShipment, Shipment } from '../../../domain/shipment';
import { TERMINAL_STATUSES, type TrackingStatus } from '../../../domain/tracking-status';

export type PrismaExecutor = PrismaClient | Prisma.TransactionClient;

export function toShipment(row: ShipmentRow): Shipment {
  return { ...row };
}

function toData(shipment: NewShipment): Prisma.ShipmentUncheckedCreateInput {
  return { ...shipment };
}

export class PrismaShipmentRepository implements ShipmentRepository {
  constructor(private readonly db: PrismaExecutor) {}

  async findById(id: string): Promise<Shipment | null> {
    const row = await this.db.shipment.findUnique({ where: { id } });
    return row && toShipment(row);
  }

  async findByCrmOrderId(crmOrderId: string): Promise<Shipment | null> {
    const row = await this.db.shipment.findUnique({ where: { crmOrderId } });
    return row && toShipment(row);
  }

  async findByTrackCode(trackCode: string): Promise<Shipment | null> {
    const row = await this.db.shipment.findUnique({ where: { trackCode } });
    return row && toShipment(row);
  }

  async create(shipment: NewShipment): Promise<Shipment> {
    return toShipment(await this.db.shipment.create({ data: toData(shipment) }));
  }

  async save(shipment: Shipment): Promise<void> {
    const { id, createdAt: _createdAt, ...data } = shipment;
    await this.db.shipment.update({ where: { id }, data });
  }

  async findActiveForPolling(limit: number): Promise<Shipment[]> {
    const rows = await this.db.shipment.findMany({
      where: { status: { notIn: [...TERMINAL_STATUSES] } },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: limit,
    });
    return rows.map(toShipment);
  }

  async findPendingCrmSync(maxAttempts: number, limit: number): Promise<Shipment[]> {
    const rows = await this.db.shipment.findMany({
      where: {
        OR: [
          { crmSyncStatus: 'PENDING' },
          { crmSyncStatus: 'FAILED', crmSyncAttempts: { lt: maxAttempts } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    return rows.map(toShipment);
  }

  async markCrmSynced(id: string, expectedStatus: TrackingStatus): Promise<boolean> {
    const { count } = await this.db.shipment.updateMany({
      where: { id, status: expectedStatus },
      data: { crmSyncStatus: 'SYNCED', crmSyncAttempts: 0 },
    });
    return count > 0;
  }

  async markCrmFailed(id: string, expectedStatus: TrackingStatus): Promise<number | null> {
    const { count } = await this.db.shipment.updateMany({
      where: { id, status: expectedStatus },
      data: { crmSyncStatus: 'FAILED', crmSyncAttempts: { increment: 1 } },
    });
    if (count === 0) return null;
    const row = await this.db.shipment.findUnique({ where: { id }, select: { crmSyncAttempts: true } });
    return row?.crmSyncAttempts ?? null;
  }

  async findActiveWithoutStuckAlert(): Promise<Shipment[]> {
    const rows = await this.db.shipment.findMany({
      where: { stuckAlertSentAt: null, status: { notIn: [...TERMINAL_STATUSES] } },
    });
    return rows.map(toShipment);
  }

  async findActive(): Promise<Shipment[]> {
    const rows = await this.db.shipment.findMany({
      where: { status: { notIn: [...TERMINAL_STATUSES] } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toShipment);
  }

  async findByStatusChangedSince(statuses: readonly TrackingStatus[], since: Date): Promise<Shipment[]> {
    const rows = await this.db.shipment.findMany({
      where: { status: { in: [...statuses] }, statusChangedAt: { gte: since } },
      orderBy: { statusChangedAt: 'asc' },
    });
    return rows.map(toShipment);
  }
}
