import type { SyncStateRepository } from '../../../application/ports/repositories';
import type { PrismaExecutor } from './shipment.repository';

export class PrismaSyncStateRepository implements SyncStateRepository {
  constructor(private readonly db: PrismaExecutor) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.syncState.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.syncState.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
}
