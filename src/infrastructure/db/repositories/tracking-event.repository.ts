import type { Prisma } from '@prisma/client';
import type { TrackingEventRepository } from '../../../application/ports/repositories';
import { computeDedupHash, type TrackingEvent } from '../../../domain/tracking-event';
import type { PrismaExecutor } from './shipment.repository';

export class PrismaTrackingEventRepository implements TrackingEventRepository {
  constructor(private readonly db: PrismaExecutor) {}

  async insertNew(
    shipmentId: string,
    trackCode: string,
    events: readonly TrackingEvent[],
  ): Promise<TrackingEvent[]> {
    if (events.length === 0) return [];
    const hashed = dedupeByHash(trackCode, events);

    const existing = await this.db.trackingEvent.findMany({
      where: { dedupHash: { in: hashed.map((h) => h.hash) } },
      select: { dedupHash: true },
    });
    const known = new Set(existing.map((row) => row.dedupHash));
    const fresh = hashed.filter((h) => !known.has(h.hash));
    if (fresh.length === 0) return [];

    await this.db.trackingEvent.createMany({
      skipDuplicates: true,
      data: fresh.map(({ hash, event }) => ({
        shipmentId,
        status: event.status,
        rawStatus: event.rawStatus,
        location: event.location,
        occurredAt: event.occurredAt,
        dedupHash: hash,
        rawPayload: event.rawPayload as Prisma.InputJsonValue,
      })),
    });
    return fresh.map((h) => h.event);
  }

  async listForShipment(shipmentId: string, limit: number): Promise<TrackingEvent[]> {
    const rows = await this.db.trackingEvent.findMany({
      where: { shipmentId },
      orderBy: { occurredAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => ({
      status: row.status,
      rawStatus: row.rawStatus,
      location: row.location,
      occurredAt: row.occurredAt,
      rawPayload: row.rawPayload,
    }));
  }

  async deleteForShipment(shipmentId: string): Promise<void> {
    await this.db.trackingEvent.deleteMany({ where: { shipmentId } });
  }
}

function dedupeByHash(
  trackCode: string,
  events: readonly TrackingEvent[],
): Array<{ hash: string; event: TrackingEvent }> {
  const byHash = new Map<string, TrackingEvent>();
  for (const event of events) {
    const hash = computeDedupHash(trackCode, event);
    if (!byHash.has(hash)) byHash.set(hash, event);
  }
  return [...byHash].map(([hash, event]) => ({ hash, event }));
}
