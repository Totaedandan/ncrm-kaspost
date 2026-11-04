import { beforeEach, describe, expect, it } from 'vitest';
import { CheckHealth } from '../../../src/application/check-health';
import { JobRunner, lastSuccessKey } from '../../../src/application/job-runner';
import { BuildDailyReport } from '../../../src/application/use-cases/build-daily-report';
import { DetectStuckShipments } from '../../../src/application/use-cases/detect-stuck-shipments';
import {
  DispatchNotifications,
  MAX_NOTIFICATION_ATTEMPTS,
} from '../../../src/application/use-cases/dispatch-notifications';
import {
  MAX_CRM_SYNC_ATTEMPTS,
  PushStatusToCrm,
} from '../../../src/application/use-cases/push-status-to-crm';
import { RateLimitedError } from '../../../src/domain/errors';
import { newShipment, type Shipment } from '../../../src/domain/shipment';
import { createSilentLogger } from '../../../src/shared/logger';
import {
  FakeCrm,
  FakeLock,
  FakeNotifier,
  FakeProbe,
  T0,
  createWorld,
  type World,
} from '../../helpers/fakes';

const logger = createSilentLogger();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function addShipment(world: World, n: number, overrides: Partial<Shipment> = {}): Promise<Shipment> {
  const created = await world.shipments.create(
    newShipment({ crmOrderId: String(n), trackCode: `RR00000000${n}KZ`, customerName: 'Иванов И.' }),
  );
  const merged = { ...created, ...overrides };
  await world.shipments.save(merged);
  return merged;
}

describe('PushStatusToCrm', () => {
  let world: World;
  let crm: FakeCrm;

  const build = (addComment = false, requiredCurrentStatus: string | null = null) =>
    new PushStatusToCrm({
      crm,
      shipments: world.shipments,
      outbox: world.outbox,
      clock: world.clock,
      logger,
      statusMap: { DELIVERED: 'stage-received', RETURNED: '' },
      addComment,
      requiredCurrentStatus,
    });

  const crmOrder = (id: string, status: string) => ({ id, trackCode: null, deliveryMethod: null, status, updatedAt: T0 });

  beforeEach(() => {
    world = createWorld();
    crm = new FakeCrm();
  });

  it('pushes a mapped status exactly once', async () => {
    const s = await addShipment(world, 1, { status: 'DELIVERED', crmSyncStatus: 'PENDING' });
    const push = build();

    const first = await push.execute();
    const second = await push.execute();

    expect(first).toEqual({ pushed: 1, skipped: 0, failed: 0 });
    expect(second).toEqual({ pushed: 0, skipped: 0, failed: 0 });
    expect(crm.statusCalls).toEqual([{ orderId: '1', statusId: 'stage-received' }]);
    expect((await world.shipments.findById(s.id))?.crmSyncStatus).toBe('SYNCED');
  });

  it('does not push statuses without a mapping, but settles them', async () => {
    const a = await addShipment(world, 1, { status: 'IN_TRANSIT', crmSyncStatus: 'PENDING' });
    const b = await addShipment(world, 2, { status: 'RETURNED', crmSyncStatus: 'PENDING' });

    const result = await build().execute();

    expect(result.skipped).toBe(2);
    expect(crm.statusCalls).toHaveLength(0);
    expect((await world.shipments.findById(a.id))?.crmSyncStatus).toBe('SYNCED');
    expect((await world.shipments.findById(b.id))?.crmSyncStatus).toBe('SYNCED');
  });

  it('retries failures up to 5 attempts, then stops and alerts the developer once', async () => {
    const s = await addShipment(world, 1, { status: 'DELIVERED', crmSyncStatus: 'PENDING' });
    crm.failStatus = new Error('crm 500');
    const push = build();

    for (let i = 0; i < MAX_CRM_SYNC_ATTEMPTS + 3; i += 1) await push.execute();

    const stored = await world.shipments.findById(s.id);
    expect(stored).toMatchObject({ crmSyncStatus: 'FAILED', crmSyncAttempts: MAX_CRM_SYNC_ATTEMPTS });
    expect(world.outboxOfType('DEV_ALERT')).toHaveLength(1);
  });

  it('recovers after a transient failure', async () => {
    const s = await addShipment(world, 1, { status: 'DELIVERED', crmSyncStatus: 'PENDING' });
    const push = build();
    crm.failStatus = new Error('flaky');
    await push.execute();
    crm.failStatus = null;

    await push.execute();

    expect(crm.statusCalls).toHaveLength(1);
    expect((await world.shipments.findById(s.id))?.crmSyncStatus).toBe('SYNCED');
  });

  it('moves the deal only while it is still in the source stage', async () => {
    crm.orders = [crmOrder('1', 'on-delivery'), crmOrder('2', 'refused'), crmOrder('3', 'on-delivery')];
    const a = await addShipment(world, 1, { status: 'DELIVERED', crmSyncStatus: 'PENDING' });
    const b = await addShipment(world, 2, { status: 'DELIVERED', crmSyncStatus: 'PENDING' });
    const gone = await addShipment(world, 4, { status: 'DELIVERED', crmSyncStatus: 'PENDING' }); // deleted in the CRM

    const result = await build(false, 'on-delivery').execute();

    expect(result).toEqual({ pushed: 1, skipped: 2, failed: 0 });
    expect(crm.statusCalls).toEqual([{ orderId: '1', statusId: 'stage-received' }]);
    for (const shipment of [a, b, gone]) {
      expect((await world.shipments.findById(shipment.id))?.crmSyncStatus).toBe('SYNCED');
    }
  });

  it('retries later when the current stage cannot be read', async () => {
    crm.orders = [crmOrder('1', 'on-delivery')];
    const s = await addShipment(world, 1, { status: 'DELIVERED', crmSyncStatus: 'PENDING' });
    crm.failRead = new Error('crm 502');

    const failed = await build(false, 'on-delivery').execute();
    crm.failRead = null;
    const recovered = await build(false, 'on-delivery').execute();

    expect(failed.failed).toBe(1);
    expect(recovered.pushed).toBe(1);
    expect((await world.shipments.findById(s.id))?.crmSyncStatus).toBe('SYNCED');
  });

  it('leaves the shipment pending when its status moved while pushing', async () => {
    const s = await addShipment(world, 1, { status: 'DELIVERED', crmSyncStatus: 'PENDING' });
    crm.updateOrderStatus = async () => {
      await world.shipments.save({ ...(await world.shipments.findById(s.id))!, status: 'UNKNOWN', crmSyncStatus: 'PENDING' });
    };

    await build().execute();

    expect((await world.shipments.findById(s.id))?.crmSyncStatus).toBe('PENDING');
  });

  it('writes a comment when enabled, and a failing comment does not fail the sync', async () => {
    const s = await addShipment(world, 1, {
      status: 'DELIVERED',
      crmSyncStatus: 'PENDING',
      rawStatus: 'Вручено адресату',
      lastLocation: 'Астана 010000',
    });
    crm.failComment = new Error('comment api down');

    const result = await build(true).execute();

    expect(result.pushed).toBe(1);
    expect((await world.shipments.findById(s.id))?.crmSyncStatus).toBe('SYNCED');

    crm.failComment = null;
    await world.shipments.save({ ...(await world.shipments.findById(s.id))!, crmSyncStatus: 'PENDING' });
    await build(true).execute();
    expect(crm.comments[0]?.text).toContain('Казпочта: Вручено адресату, Астана 010000');
  });
});

describe('DispatchNotifications', () => {
  let world: World;
  let notifier: FakeNotifier;

  const build = () => new DispatchNotifications({ notifier, outbox: world.outbox, clock: world.clock, logger });
  const enqueue = (key: string) =>
    world.outbox.enqueue({ type: 'DEV_ALERT', dedupKey: key, payload: { title: key, details: '' } });

  beforeEach(() => {
    world = createWorld();
    notifier = new FakeNotifier();
  });

  it('sends each outbox entry exactly once across runs', async () => {
    await enqueue('a');
    await enqueue('b');
    const dispatch = build();

    const first = await dispatch.execute();
    const second = await dispatch.execute();

    expect(first.sent).toBe(2);
    expect(second.sent).toBe(0);
    expect(notifier.sent).toHaveLength(2);
  });

  it('enqueueing the same dedupKey twice yields one notification', async () => {
    expect(await enqueue('same')).toBe(true);
    expect(await enqueue('same')).toBe(false);
    await build().execute();
    expect(notifier.sent).toHaveLength(1);
  });

  it('retries a failed delivery later with backoff and gives up after 5 attempts', async () => {
    await enqueue('x');
    notifier.failWith = new Error('telegram down');
    const dispatch = build();

    let attempts = 0;
    for (let i = 0; i < MAX_NOTIFICATION_ATTEMPTS + 2; i += 1) {
      const result = await dispatch.execute();
      attempts += result.failed;
      world.clock.advance(2 * DAY);
    }

    const row = [...world.store.outbox.values()][0];
    expect(attempts).toBe(MAX_NOTIFICATION_ATTEMPTS);
    expect(row).toMatchObject({ status: 'FAILED', attempts: MAX_NOTIFICATION_ATTEMPTS });
  });

  it('does not retry before the backoff has elapsed', async () => {
    await enqueue('x');
    notifier.failWith = new Error('telegram down');
    const dispatch = build();
    await dispatch.execute();
    notifier.failWith = null;

    expect((await dispatch.execute()).sent).toBe(0);
    world.clock.advance(2 * 60_000);
    expect((await dispatch.execute()).sent).toBe(1);
  });

  it('on 429 postpones by retry_after, consumes no attempt and stops the run', async () => {
    await enqueue('a');
    await enqueue('b');
    notifier.failWith = new RateLimitedError(40);
    const dispatch = build();

    const limited = await dispatch.execute();
    notifier.failWith = null;
    const tooEarly = await dispatch.execute();
    world.clock.advance(41_000);
    const later = await dispatch.execute();

    expect(limited).toMatchObject({ sent: 0, rateLimited: true });
    expect(tooEarly.sent).toBe(1); // 'b' was never touched
    expect(later.sent).toBe(1);
    expect([...world.store.outbox.values()].every((r) => r.attempts === 0)).toBe(true);
  });
});

describe('DetectStuckShipments', () => {
  let world: World;
  const config = { stuckInOfficeDays: 5, noUpdatesDays: 10 };
  const build = () => new DetectStuckShipments({ shipments: world.shipments, tx: world.tx, clock: world.clock, config });

  beforeEach(() => {
    world = createWorld();
  });

  it('alerts once per parcel, however often it runs', async () => {
    await addShipment(world, 1, {
      status: 'ARRIVED_AT_OFFICE',
      statusChangedAt: new Date(T0.getTime() - 6 * DAY),
      lastEventAt: new Date(T0.getTime() - 6 * DAY),
    });
    const detect = build();

    const first = await detect.execute();
    world.clock.advance(HOUR);
    const second = await detect.execute();

    expect(first.alerted).toBe(1);
    expect(second.alerted).toBe(0);
    expect(world.outboxOfType('STUCK')).toHaveLength(1);
    expect(world.outboxOfType('STUCK')[0]).toMatchObject({ payload: { reason: 'IN_OFFICE', days: 6 } });
  });

  it('alerts about parcels without news and skips healthy or terminal ones', async () => {
    await addShipment(world, 1, { status: 'IN_TRANSIT', lastEventAt: new Date(T0.getTime() - 11 * DAY) });
    await addShipment(world, 2, { status: 'IN_TRANSIT', lastEventAt: new Date(T0.getTime() - 1 * DAY) });
    await addShipment(world, 3, { status: 'DELIVERED', lastEventAt: new Date(T0.getTime() - 30 * DAY) });

    const result = await build().execute();

    expect(result.alerted).toBe(1);
    expect(world.outboxOfType('STUCK')[0]).toMatchObject({ payload: { reason: 'NO_UPDATES', crmOrderId: '1' } });
  });

  it('listStuck is read-only and includes already alerted parcels', async () => {
    await addShipment(world, 1, { status: 'IN_TRANSIT', lastEventAt: new Date(T0.getTime() - 11 * DAY), stuckAlertSentAt: T0 });
    const stuck = await build().listStuck();
    expect(stuck).toHaveLength(1);
    expect(world.outboxEntries()).toHaveLength(0);
  });
});

describe('BuildDailyReport', () => {
  let world: World;

  const build = () => {
    const detectStuck = new DetectStuckShipments({
      shipments: world.shipments,
      tx: world.tx,
      clock: world.clock,
      config: { stuckInOfficeDays: 5, noUpdatesDays: 10 },
    });
    return new BuildDailyReport({
      shipments: world.shipments,
      outbox: world.outbox,
      detectStuck,
      clock: world.clock,
    });
  };

  const ref = (crmOrderId: string, trackCode: string) => ({ crmOrderId, trackCode, customerName: null });

  beforeEach(async () => {
    world = createWorld();
    await addShipment(world, 1, { status: 'DELIVERED', statusChangedAt: new Date(T0.getTime() - 2 * HOUR) });
    await addShipment(world, 2, { status: 'DELIVERED', statusChangedAt: new Date(T0.getTime() - 3 * DAY) });
    await addShipment(world, 3, { status: 'IN_TRANSIT', lastEventAt: T0 });
    await addShipment(world, 4, { status: 'ARRIVED_AT_OFFICE', statusChangedAt: T0, lastEventAt: T0 });
    await addShipment(world, 6, { status: 'RETURNED', statusChangedAt: new Date(T0.getTime() - HOUR) });
    await addShipment(world, 8, { status: 'RETURNED', statusChangedAt: new Date(T0.getTime() - 3 * DAY) });
    await addShipment(world, 7, { status: 'IN_TRANSIT', lastEventAt: new Date(T0.getTime() - 12 * DAY) });
  });

  it('groups shipments into report sections', async () => {
    const report = await build().build();
    const orders = (refs: Array<{ crmOrderId: string }>) => refs.map((r) => r.crmOrderId).sort();

    expect(orders(report.delivered)).toEqual(['1']);
    expect(report).not.toHaveProperty('inTransit');
    expect(orders(report.atOffice)).toEqual(['4']);
    expect(orders(report.stuck)).toEqual(['7']);
    expect(orders(report.returns)).toEqual(['6']);
  });

  it('after a poll: one summary per hour carrying the number of checked tracks', async () => {
    const report = build();
    const run = { polled: 7, delivered: [], returned: [] };

    const first = await report.enqueuePollSummary(run);
    const repeat = await report.enqueuePollSummary(run);
    world.clock.advance(HOUR);
    const nextHour = await report.enqueuePollSummary({ ...run, polled: 5 });

    expect([first.enqueued, repeat.enqueued, nextHour.enqueued]).toEqual([true, false, true]);
    expect((await report.build(run)).checked).toBe(7);
    expect(await report.build()).not.toHaveProperty('checked');
  });

  it('after a poll: delivered and returned are exactly what that run found, not a time window', async () => {
    const run = {
      polled: 9,
      delivered: [ref('11', 'RR000000011KZ')],
      returned: [ref('12', 'RR000000012KZ'), ref('13', 'RR000000013KZ')],
    };

    const payload = await build().build(run);

    expect(payload.delivered).toEqual(run.delivered);
    expect(payload.returns).toEqual(run.returned);
    expect(payload.atOffice.map((r) => r.crmOrderId)).toEqual(['4']);
  });
});

describe('JobRunner', () => {
  let world: World;
  let lock: FakeLock;
  const runner = () =>
    new JobRunner({
      lock,
      syncState: world.syncState,
      outbox: world.outbox,
      clock: world.clock,
      logger,
      newCorrelationId: () => 'corr-1',
    });

  beforeEach(() => {
    world = createWorld();
    lock = new FakeLock();
  });

  it('runs the job, records the success time and releases the lock', async () => {
    let ran = false;
    const outcome = await runner().run('poll-tracking', async () => void (ran = true));

    expect(outcome).toBe('ok');
    expect(ran).toBe(true);
    expect(await world.syncState.get(lastSuccessKey('poll-tracking'))).toBe(T0.toISOString());
    expect(lock.held.size).toBe(0);
  });

  it('skips when another instance holds the lock', async () => {
    lock.held.add('poll-tracking');
    let ran = false;

    const outcome = await runner().run('poll-tracking', async () => void (ran = true));

    expect(outcome).toBe('skipped');
    expect(ran).toBe(false);
    expect(await world.syncState.get(lastSuccessKey('poll-tracking'))).toBeNull();
  });

  it('does not allow two overlapping runs of the same job', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = runner().run('sync-crm', () => gate);
    await Promise.resolve();
    await Promise.resolve();

    const overlapping = await runner().run('sync-crm', async () => undefined);
    release();

    expect(overlapping).toBe('skipped');
    expect(await first).toBe('ok');
  });

  it('catches failures, alerts the developer, keeps the old success time and releases the lock', async () => {
    const outcome = await runner().run('push-crm', async () => {
      throw new Error('kaboom');
    });

    expect(outcome).toBe('failed');
    expect(lock.held.size).toBe(0);
    expect(await world.syncState.get(lastSuccessKey('push-crm'))).toBeNull();
    expect(world.outboxOfType('DEV_ALERT')[0]).toMatchObject({ payload: { details: 'kaboom' } });
  });
});

describe('CheckHealth', () => {
  let world: World;
  let probe: FakeProbe;
  const build = () => new CheckHealth({ probe, syncState: world.syncState, clock: world.clock, startedAt: T0 });

  beforeEach(() => {
    world = createWorld();
    probe = new FakeProbe();
  });

  it('is healthy right after startup, before the first poll', async () => {
    expect((await build().execute()).ok).toBe(true);
  });

  it('is unhealthy when poll has not run for more than 13 hours (twice-a-day schedule plus slack)', async () => {
    await world.syncState.set(lastSuccessKey('poll-tracking'), T0.toISOString());
    world.clock.advance(13 * HOUR + 60_000);

    const report = await build().execute();

    expect(report.ok).toBe(false);
    expect(report.problems.join()).toContain('poll-tracking');
  });

  it('is healthy between two scheduled polls', async () => {
    await world.syncState.set(lastSuccessKey('poll-tracking'), T0.toISOString());
    world.clock.advance(12 * HOUR + 5 * 60_000);
    expect((await build().execute()).ok).toBe(true);
  });

  it('honours a custom staleness limit', async () => {
    await world.syncState.set(lastSuccessKey('poll-tracking'), T0.toISOString());
    world.clock.advance(31 * 60_000);
    const strict = new CheckHealth({ probe, syncState: world.syncState, clock: world.clock, startedAt: T0, pollStaleAfterMs: 30 * 60_000 });
    expect((await strict.execute()).ok).toBe(false);
  });

  it('is unhealthy when the database is down', async () => {
    probe.up = false;
    const report = await build().execute();
    expect(report).toMatchObject({ ok: false, database: false });
  });
});
