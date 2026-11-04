import type { PrismaClient } from '@prisma/client';
import type { TransactionRunner, TxRepositories } from '../../../application/ports/repositories';
import { PrismaOutboxRepository } from './outbox.repository';
import { PrismaShipmentRepository } from './shipment.repository';
import { PrismaTrackingEventRepository } from './tracking-event.repository';

const TRANSACTION_TIMEOUT_MS = 15_000;

export class PrismaTransactionRunner implements TransactionRunner {
  constructor(private readonly prisma: PrismaClient) {}

  run<T>(work: (repos: TxRepositories) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      (tx) =>
        work({
          shipments: new PrismaShipmentRepository(tx),
          events: new PrismaTrackingEventRepository(tx),
          outbox: new PrismaOutboxRepository(tx),
        }),
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }
}
