import { PrismaClient } from '@prisma/client';
import type { HealthProbe } from '../../application/ports/repositories';

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}

export class PrismaHealthProbe implements HealthProbe {
  constructor(private readonly prisma: PrismaClient) {}

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
