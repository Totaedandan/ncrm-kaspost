import type { Prisma } from '@prisma/client';
import type { OutboxMessage, OutboxRepository } from '../../../application/ports/repositories';
import type { OutboxEntry } from '../../../domain/notification';
import type { PrismaExecutor } from './shipment.repository';

export class PrismaOutboxRepository implements OutboxRepository {
  constructor(private readonly db: PrismaExecutor) {}

  async enqueue(entry: OutboxEntry): Promise<boolean> {
    const { count } = await this.db.notificationOutbox.createMany({
      skipDuplicates: true,
      data: [
        {
          type: entry.type,
          dedupKey: entry.dedupKey,
          // Dispatchable immediately; independent of DB-vs-app clock skew.
          nextAttemptAt: new Date(0),
          payload: entry.payload as unknown as Prisma.InputJsonValue,
        },
      ],
    });
    return count > 0;
  }

  async findDispatchable(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.db.notificationOutbox.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: now } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      attempts: row.attempts,
      // The payload was written by enqueue() from a typed OutboxEntry.
      entry: { type: row.type, dedupKey: row.dedupKey, payload: row.payload } as unknown as OutboxEntry,
    }));
  }

  async markSent(id: string, now: Date): Promise<void> {
    await this.db.notificationOutbox.update({
      where: { id },
      data: { status: 'SENT', sentAt: now, lastError: null },
    });
  }

  async markAttemptFailed(id: string, error: string, nextAttemptAt: Date, giveUp: boolean): Promise<void> {
    await this.db.notificationOutbox.update({
      where: { id },
      data: {
        attempts: { increment: 1 },
        lastError: error.slice(0, 1000),
        nextAttemptAt,
        status: giveUp ? 'FAILED' : 'PENDING',
      },
    });
  }

  async postpone(id: string, nextAttemptAt: Date): Promise<void> {
    await this.db.notificationOutbox.update({ where: { id }, data: { nextAttemptAt } });
  }
}
