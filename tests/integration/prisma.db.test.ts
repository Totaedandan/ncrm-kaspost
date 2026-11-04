import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { JobRunner } from '../../src/application/job-runner';
import { PollTrackingStatuses } from '../../src/application/use-cases/poll-tracking-statuses';
import { newShipment } from '../../src/domain/shipment';
import { TRACKING_STATUSES } from '../../src/domain/tracking-status';
import { PrismaOutboxRepository } from '../../src/infrastructure/db/repositories/outbox.repository';
import { PrismaShipmentRepository } from '../../src/infrastructure/db/repositories/shipment.repository';
import { PrismaSyncStateRepository } from '../../src/infrastructure/db/repositories/sync-state.repository';
import { PrismaTrackingEventRepository } from '../../src/infrastructure/db/repositories/tracking-event.repository';
import { PrismaTransactionRunner } from '../../src/infrastructure/db/repositories/transaction-runner';
import { PrismaHealthProbe } from '../../src/infrastructure/db/prisma';
import { PgAdvisoryLock } from '../../src/infrastructure/scheduler/advisory-lock';
import { createSilentLogger } from '../../src/shared/logger';
import { FakeTracking, TestClock, event } from '../helpers/fakes';
import { TEST_DATABASE_URL } from './global-setup';

const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
const shipments = new PrismaShipmentRepository(prisma);
const events = new PrismaTrackingEventRepository(prisma);
const outbox = new PrismaOutboxRepository(prisma);
const syncState = new PrismaSyncStateRepository(prisma);
const tx = new PrismaTransactionRunner(prisma);
const clock = new TestClock(new Date('2026-11-01T10:00:00Z'));

function fresh(n: number, trackCode = `RR00000000${n}KZ`) {
  return newShipment({ crmOrderId: String(n), trackCode, customerName: 'Иванов И.' });
}

beforeEach(async () => {
  await prisma.trackingEvent.deleteMany();
  await prisma.notificationOutbox.deleteMany();
  await prisma.shipment.deleteMany();
  await prisma.syncState.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Prisma repositories', () => {
  it('round-trips a shipment and rejects duplicate crmOrderId / trackCode', async () => {
    const created = await shipments.create(fresh(1));
    expect(await shipments.findByTrackCode('RR000000001KZ')).toMatchObject({ id: created.id, status: 'REGISTERED' });

    await expect(shipments.create(fresh(1, 'RR111111111KZ'))).rejects.toThrow();
    await expect(shipments.create(fresh(2, 'RR000000001KZ'))).rejects.toThrow();
  });

  it('save persists mutable fields', async () => {
    const created = await shipments.create(fresh(1));
    await shipments.save({ ...created, status: 'IN_TRANSIT', rawStatus: 'В пути', crmSyncStatus: 'PENDING' });
    expect(await shipments.findById(created.id)).toMatchObject({ status: 'IN_TRANSIT', rawStatus: 'В пути', crmSyncStatus: 'PENDING' });
  });

  it('findActiveForPolling skips terminal shipments and puts the least recently checked first', async () => {
    const checkedLong = await shipments.create(fresh(1));
    const delivered = await shipments.create(fresh(2));
    const never = await shipments.create(fresh(3));
    const checkedRecently = await shipments.create(fresh(4));
    await shipments.save({ ...delivered, status: 'DELIVERED' });
    await shipments.save({ ...checkedLong, lastCheckedAt: new Date('2026-11-01T08:00:00Z') });
    await shipments.save({ ...checkedRecently, lastCheckedAt: new Date('2026-11-02T08:00:00Z') });

    const result = await shipments.findActiveForPolling(10);

    expect(result.map((s) => s.id)).toEqual([never.id, checkedLong.id, checkedRecently.id]);
    expect(await shipments.findActiveForPolling(1)).toHaveLength(1);
  });

  it('markCrmSynced only applies while the status is unchanged', async () => {
    const created = await shipments.create(fresh(1));
    await shipments.save({ ...created, status: 'DELIVERED', crmSyncStatus: 'PENDING' });

    expect(await shipments.markCrmSynced(created.id, 'IN_TRANSIT')).toBe(false);
    expect(await shipments.markCrmSynced(created.id, 'DELIVERED')).toBe(true);
    expect((await shipments.findById(created.id))?.crmSyncStatus).toBe('SYNCED');
  });

  it('markCrmFailed counts attempts and findPendingCrmSync honours the limit', async () => {
    const created = await shipments.create(fresh(1));
    await shipments.save({ ...created, status: 'DELIVERED', crmSyncStatus: 'PENDING' });

    for (let i = 1; i <= 5; i += 1) expect(await shipments.markCrmFailed(created.id, 'DELIVERED')).toBe(i);

    expect(await shipments.findPendingCrmSync(5, 10)).toHaveLength(0);
    expect(await shipments.findPendingCrmSync(6, 10)).toHaveLength(1);
  });

  it('events: insertNew skips duplicates and returns only new events', async () => {
    const s = await shipments.create(fresh(1));
    const first = event('IN_TRANSIT', '2026-11-01T08:00:00Z');
    const second = event('ARRIVED_AT_OFFICE', '2026-11-01T09:00:00Z');

    expect(await events.insertNew(s.id, s.trackCode, [first])).toHaveLength(1);
    expect(await events.insertNew(s.id, s.trackCode, [first, second, second])).toHaveLength(1);
    expect(await events.insertNew(s.id, s.trackCode, [first, second])).toHaveLength(0);
    expect(await events.listForShipment(s.id, 10)).toHaveLength(2);
  });

  it('outbox: enqueue is idempotent per dedupKey and dispatch bookkeeping works', async () => {
    const entry = { type: 'DEV_ALERT', dedupKey: 'k1', payload: { title: 't', details: 'd' } } as const;
    expect(await outbox.enqueue(entry)).toBe(true);
    expect(await outbox.enqueue(entry)).toBe(false);

    const [message] = await outbox.findDispatchable(clock.now(), 10);
    expect(message?.entry).toMatchObject({ type: 'DEV_ALERT', payload: { title: 't' } });

    await outbox.markAttemptFailed(message!.id, 'boom', new Date(clock.now().getTime() + 60_000), false);
    expect(await outbox.findDispatchable(clock.now(), 10)).toHaveLength(0);
    expect(await outbox.findDispatchable(new Date(clock.now().getTime() + 61_000), 10)).toHaveLength(1);

    await outbox.markSent(message!.id, clock.now());
    expect(await outbox.findDispatchable(new Date(clock.now().getTime() + 999_999), 10)).toHaveLength(0);
  });

  it('sync state upserts', async () => {
    expect(await syncState.get('k')).toBeNull();
    await syncState.set('k', 'a');
    await syncState.set('k', 'b');
    expect(await syncState.get('k')).toBe('b');
  });

  it('health probe pings the database', async () => {
    await expect(new PrismaHealthProbe(prisma).ping()).resolves.toBeUndefined();
  });
});

describe('transactions', () => {
  it('roll back every write when the work throws', async () => {
    const s = await shipments.create(fresh(1));

    await expect(
      tx.run(async (repos) => {
        await repos.shipments.save({ ...s, status: 'DELIVERED' });
        await repos.outbox.enqueue({ type: 'DEV_ALERT', dedupKey: 'inside-tx', payload: { title: 't', details: 'd' } });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    expect((await shipments.findById(s.id))?.status).toBe('REGISTERED');
    expect(await prisma.notificationOutbox.count()).toBe(0);
  });
});

describe('PgAdvisoryLock', () => {
  const lock = new PgAdvisoryLock(TEST_DATABASE_URL);

  it('is exclusive per name and reusable after release', async () => {
    const first = await lock.tryAcquire('job-a');
    expect(first).not.toBeNull();
    expect(await lock.tryAcquire('job-a')).toBeNull();

    const other = await lock.tryAcquire('job-b');
    expect(other).not.toBeNull();

    await first!.release();
    const again = await lock.tryAcquire('job-a');
    expect(again).not.toBeNull();

    await again!.release();
    await other!.release();
  });

  it('makes a second JobRunner (another instance) skip a running job', async () => {
    const make = () =>
      new JobRunner({ lock: new PgAdvisoryLock(TEST_DATABASE_URL), syncState, outbox, clock, logger: createSilentLogger() });
    let release!: () => void;
    const running = make().run('poll-tracking', () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((r) => setTimeout(r, 200));

    const second = await make().run('poll-tracking', async () => undefined);
    release();

    expect(second).toBe('skipped');
    expect(await running).toBe('ok');
  });
});

describe('PollTrackingStatuses on real Postgres', () => {
  it('a double run produces one event set and one notification', async () => {
    const s = await shipments.create(fresh(1));
    const tracking = new FakeTracking();
    tracking.respond(s.trackCode, [
      event('REGISTERED', '2026-10-30T08:00:00Z'),
      event('IN_TRANSIT', '2026-10-31T08:00:00Z'),
    ]);
    const poll = new PollTrackingStatuses({
      tracking,
      shipments,
      outbox,
      tx,
      clock,
      logger: createSilentLogger(),
      config: { batchSize: 10, concurrency: 2, minIntervalMs: 0, notifyStatuses: TRACKING_STATUSES },
    });

    await poll.execute();
    clock.advance(3 * 3_600_000);
    await poll.execute();

    expect(await prisma.trackingEvent.count()).toBe(2);
    expect(await prisma.notificationOutbox.count()).toBe(1);
    expect(await shipments.findById(s.id)).toMatchObject({ status: 'IN_TRANSIT', crmSyncStatus: 'PENDING' });
  });
});
