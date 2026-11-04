import { beforeEach, describe, expect, it } from 'vitest';
import { PollTrackingStatuses } from '../../../src/application/use-cases/poll-tracking-statuses';
import {
  CRM_CURSOR_KEY,
  SyncShipmentsFromCrm,
} from '../../../src/application/use-cases/sync-shipments-from-crm';
import { ExternalSchemaError, ExternalServiceError } from '../../../src/domain/errors';
import { DEFAULT_TRACK_CODE_PATTERN } from '../../../src/domain/track-code';
import { TRACKING_STATUSES } from '../../../src/domain/tracking-status';
import { createSilentLogger } from '../../../src/shared/logger';
import {
  FakeCrm,
  FakeTracking,
  createWorld,
  event,
  order,
  type World,
} from '../../helpers/fakes';

const HOUR = 3_600_000;
const logger = createSilentLogger();

describe('SyncShipmentsFromCrm', () => {
  let world: World;
  let crm: FakeCrm;
  let sync: SyncShipmentsFromCrm;

  beforeEach(() => {
    world = createWorld();
    crm = new FakeCrm([
      order({ id: '1', trackCode: 'RR000000001KZ', updatedAt: new Date('2026-10-30T10:00:00Z') }),
      order({ id: '2', trackCode: 'RR000000002KZ', updatedAt: new Date('2026-10-31T10:00:00Z') }),
      order({ id: '3', trackCode: null, deliveryMethod: 'Курьер' }),
      order({ id: '4', trackCode: 'RR000000004KZ', deliveryMethod: 'Курьер' }),
      order({ id: '5', trackCode: 'broken' }),
    ]);
    sync = new SyncShipmentsFromCrm({
      crm,
      shipments: world.shipments,
      syncState: world.syncState,
      tx: world.tx,
      logger,
      filter: { deliveryValue: 'Казпочта', trackPattern: DEFAULT_TRACK_CODE_PATTERN },
    });
  });

  it('creates shipments only for Kazpost orders with a valid track; couriers are ignored', async () => {
    const result = await sync.execute();

    expect(result).toMatchObject({ seen: 5, created: 2, skipped: 3 });
    expect([...world.store.shipments.values()].map((s) => s.crmOrderId).sort()).toEqual(['1', '2']);
  });

  it('is idempotent: a second run creates nothing new', async () => {
    await sync.execute();
    const second = await sync.execute();

    expect(second.created).toBe(0);
    expect(world.store.shipments.size).toBe(2);
  });

  it('moves the cursor to the newest updatedAt', async () => {
    await sync.execute();
    expect(await world.syncState.get(CRM_CURSOR_KEY)).toBe(new Date('2026-10-31T10:00:00Z').toISOString());
  });

  it('does not move the cursor when the batch fails halfway', async () => {
    const failing = world.shipments;
    let calls = 0;
    const original = failing.create.bind(failing);
    failing.create = async (data) => {
      calls += 1;
      if (calls === 2) throw new Error('db hiccup');
      return original(data);
    };

    await expect(sync.execute()).rejects.toThrow('db hiccup');
    expect(await world.syncState.get(CRM_CURSOR_KEY)).toBeNull();

    failing.create = original;
    await sync.execute();
    expect(world.store.shipments.size).toBe(2);
  });

  it('resets tracking state and drops old events when the order gets a new track', async () => {
    await sync.execute();
    const first = await world.shipments.findByCrmOrderId('1');
    await world.events.insertNew(first!.id, first!.trackCode, [event('IN_TRANSIT', '2026-10-31T00:00:00Z')]);
    await world.shipments.save({ ...first!, status: 'IN_TRANSIT' });

    crm.orders = [order({ id: '1', trackCode: 'RR999999999KZ', updatedAt: new Date('2026-11-01T00:00:00Z') })];
    const result = await sync.execute();

    const updated = await world.shipments.findByCrmOrderId('1');
    expect(result.trackChanged).toBe(1);
    expect(updated).toMatchObject({ trackCode: 'RR999999999KZ', status: 'REGISTERED', id: first!.id });
    expect(world.store.events.size).toBe(0);
  });

  it('does not steal a track that already belongs to another order', async () => {
    await sync.execute();
    crm.orders = [order({ id: '9', trackCode: 'RR000000001KZ', updatedAt: new Date('2026-11-01T00:00:00Z') })];

    await sync.execute();

    expect(await world.shipments.findByCrmOrderId('9')).toBeNull();
  });

  it('refreshes the customer name', async () => {
    await sync.execute();
    crm.orders = [order({ id: '1', trackCode: 'RR000000001KZ', customerName: 'Новое Имя', updatedAt: new Date('2026-11-01T00:00:00Z') })];
    await sync.execute();
    expect((await world.shipments.findByCrmOrderId('1'))?.customerName).toBe('Новое Имя');
  });
});

describe('PollTrackingStatuses', () => {
  let world: World;
  let tracking: FakeTracking;

  const build = (concurrency = 3) =>
    new PollTrackingStatuses({
      tracking,
      shipments: world.shipments,
      outbox: world.outbox,
      tx: world.tx,
      clock: world.clock,
      logger,
      config: { batchSize: 50, concurrency, minIntervalMs: 0, notifyStatuses: TRACKING_STATUSES },
    });

  const addShipment = async (n: number, trackCode = `RR00000000${n}KZ`) =>
    world.shipments.create({
      crmOrderId: String(n),
      trackCode,
      customerName: 'Иванов И.',
      status: 'REGISTERED',
      rawStatus: null,
      lastLocation: null,
      statusChangedAt: null,
      lastEventAt: null,
      lastCheckedAt: null,
      pollErrorCount: 0,
      deliveredAt: null,
      crmSyncStatus: 'SYNCED',
      crmSyncAttempts: 0,
      stuckAlertSentAt: null,
    });

  beforeEach(() => {
    world = createWorld();
    tracking = new FakeTracking();
  });

  it('on a status change updates the shipment, marks CRM sync pending and writes one outbox entry', async () => {
    const shipment = await addShipment(1);
    tracking.respond(shipment.trackCode, [event('IN_TRANSIT', '2026-11-01T08:00:00Z', { location: 'Алматы' })]);

    const result = await build().execute();

    const updated = await world.shipments.findById(shipment.id);
    expect(result).toMatchObject({ polled: 1, statusChanges: 1, failures: 0 });
    expect(updated).toMatchObject({ status: 'IN_TRANSIT', crmSyncStatus: 'PENDING' });
    expect(world.outboxEntries()).toHaveLength(1);
    expect(world.outboxEntries()[0]).toMatchObject({
      type: 'STATUS_CHANGED',
      dedupKey: `${shipment.id}:IN_TRANSIT`,
      payload: { trackCode: shipment.trackCode, status: 'IN_TRANSIT', location: 'Алматы' },
    });
  });

  it('stays silent for statuses that are not in notifyStatuses, but still tracks them and syncs the CRM', async () => {
    const shipment = await addShipment(1);
    tracking.respond(shipment.trackCode, [event('IN_TRANSIT', '2026-11-01T08:00:00Z')]);
    const quiet = new PollTrackingStatuses({
      tracking,
      shipments: world.shipments,
      outbox: world.outbox,
      tx: world.tx,
      clock: world.clock,
      logger,
      config: { batchSize: 50, concurrency: 1, minIntervalMs: 0, notifyStatuses: ['DELIVERED'] },
    });

    const result = await quiet.execute();

    expect(result.statusChanges).toBe(1);
    expect(await world.shipments.findById(shipment.id)).toMatchObject({ status: 'IN_TRANSIT', crmSyncStatus: 'PENDING' });
    expect(world.outboxEntries()).toHaveLength(0);

    tracking.respond(shipment.trackCode, [event('DELIVERED', '2026-11-02T08:00:00Z')]);
    await quiet.execute();
    expect(world.outboxOfType('DELIVERED')).toHaveLength(1);
  });

  it('uses the DELIVERED notification type on delivery', async () => {
    const shipment = await addShipment(1);
    tracking.respond(shipment.trackCode, [event('DELIVERED', '2026-11-01T08:00:00Z')]);
    await build().execute();
    expect(world.outboxOfType('DELIVERED')).toHaveLength(1);
  });

  it('a parcel that went back to the sender becomes RETURNED (not DELIVERED) and is listed in the run result', async () => {
    const returned = await addShipment(1);
    const delivered = await addShipment(2);
    tracking.respond(returned.trackCode, [
      event('ARRIVED_AT_OFFICE', '2026-10-16T08:00:00Z'),
      event('RETURNING', '2026-10-19T06:00:00Z'),
      event('DELIVERED', '2026-11-03T10:00:00Z'),
    ]);
    tracking.respond(delivered.trackCode, [event('DELIVERED', '2026-11-03T09:00:00Z')]);

    const result = await build().execute();

    expect(await world.shipments.findById(returned.id)).toMatchObject({ status: 'RETURNED', crmSyncStatus: 'PENDING', deliveredAt: null });
    expect(result.returned.map((r) => r.crmOrderId)).toEqual(['1']);
    expect(result.returned[0]).toMatchObject({ trackCode: returned.trackCode });
    expect(result.delivered.map((r) => r.crmOrderId)).toEqual(['2']);
    expect(world.outboxOfType('DELIVERED').map((n) => n.dedupKey)).toEqual([`${delivered.id}:DELIVERED`]);
  });

  it('a returned parcel is not polled again, so it cannot be reported twice', async () => {
    const shipment = await addShipment(1);
    tracking.respond(shipment.trackCode, [event('RETURNING', '2026-10-19T06:00:00Z')]);
    const poll = build();
    await poll.execute();
    world.clock.advance(24 * HOUR);

    const second = await poll.execute();

    expect(second).toMatchObject({ polled: 0, returned: [], delivered: [] });
  });

  it('is idempotent: a second pass over identical data adds no events, notifications or CRM work', async () => {
    const shipment = await addShipment(1);
    tracking.respond(shipment.trackCode, [event('IN_TRANSIT', '2026-11-01T08:00:00Z')]);
    const poll = build();

    await poll.execute();
    const afterFirst = await world.shipments.findById(shipment.id);
    world.clock.advance(3 * HOUR);
    await world.shipments.markCrmSynced(shipment.id, 'IN_TRANSIT');
    const second = await poll.execute();

    expect(second.polled).toBe(1);
    expect(second.statusChanges).toBe(0);
    expect(world.outboxEntries()).toHaveLength(1);
    expect(world.store.events.size).toBe(1);
    expect((await world.shipments.findById(shipment.id))?.crmSyncStatus).toBe('SYNCED');
    expect(afterFirst?.crmSyncStatus).toBe('PENDING');
  });

  it('never duplicates a notification even if the same transition is applied twice', async () => {
    const shipment = await addShipment(1);
    tracking.respond(shipment.trackCode, [event('IN_TRANSIT', '2026-11-01T08:00:00Z')]);
    await build().execute();
    // Simulate a lost write: the shipment goes back to REGISTERED, so the transition fires again.
    const current = await world.shipments.findById(shipment.id);
    await world.shipments.save({ ...current!, status: 'REGISTERED' });

    await build().execute();

    expect(world.outboxEntries()).toHaveLength(1);
  });

  it('stops polling a DELIVERED shipment', async () => {
    const shipment = await addShipment(1);
    tracking.respond(shipment.trackCode, [event('DELIVERED', '2026-11-01T08:00:00Z')]);
    const poll = build();
    await poll.execute();
    world.clock.advance(100 * HOUR);

    const second = await poll.execute();

    expect(second.polled).toBe(0);
    expect(tracking.requests).toHaveLength(1);
  });

  it('polls every active shipment on each run, and skips terminal ones', async () => {
    const a = await addShipment(1);
    const later = await addShipment(2);
    const delivered = await addShipment(3);
    await world.shipments.save({ ...delivered, status: 'DELIVERED' });

    const result = await build().execute();

    expect(result.polled).toBe(2);
    expect([...tracking.requests].sort()).toEqual([a.trackCode, later.trackCode].sort());
  });

  it('with a cap smaller than the backlog, rotates through the least recently checked first', async () => {
    const a = await addShipment(1);
    const b = await addShipment(2);
    const poll = new PollTrackingStatuses({
      tracking,
      shipments: world.shipments,
      outbox: world.outbox,
      tx: world.tx,
      clock: world.clock,
      logger,
      config: { batchSize: 1, concurrency: 1, minIntervalMs: 0, notifyStatuses: TRACKING_STATUSES },
    });

    await poll.execute();
    world.clock.advance(HOUR);
    await poll.execute();

    expect(tracking.requests).toEqual([a.trackCode, b.trackCode]);
  });

  it('treats an empty history as success and keeps the status', async () => {
    const shipment = await addShipment(1);
    const result = await build().execute();

    expect(result.failures).toBe(0);
    expect(await world.shipments.findById(shipment.id)).toMatchObject({ status: 'REGISTERED', pollErrorCount: 0 });
    expect(world.outboxEntries()).toHaveLength(0);
  });

  it('counts consecutive API failures, retries on the next run, and does not notify', async () => {
    const shipment = await addShipment(1);
    tracking.respond(shipment.trackCode, new ExternalServiceError('kazpost', 'down'));
    const poll = build();

    await poll.execute();
    const first = await world.shipments.findById(shipment.id);
    world.clock.advance(12 * HOUR);
    await poll.execute();
    const second = await world.shipments.findById(shipment.id);

    expect(first?.pollErrorCount).toBe(1);
    expect(second?.pollErrorCount).toBe(2);
    expect(second?.lastCheckedAt).toEqual(world.clock.now());
    expect(world.outboxEntries()).toHaveLength(0);
  });

  it('a schema mismatch raises one DEV_ALERT and does not break the rest of the batch', async () => {
    const bad = await addShipment(1);
    const good = await addShipment(2);
    tracking.respond(bad.trackCode, new ExternalSchemaError('kazpost', 'weird', '{"x":1}'));
    tracking.respond(good.trackCode, [event('IN_TRANSIT', '2026-11-01T08:00:00Z')]);
    const poll = build();

    const result = await poll.execute();
    world.clock.advance(12 * HOUR); // the next scheduled run polls the failing track again
    await poll.execute();

    expect(result).toMatchObject({ schemaErrors: 1, statusChanges: 1 });
    expect(world.outboxOfType('DEV_ALERT')).toHaveLength(1); // same track, same day -> deduplicated
    expect((await world.shipments.findById(good.id))?.status).toBe('IN_TRANSIT');
  });

  it('maps an unknown Kazpost status to UNKNOWN, alerts the developer once, and stays quiet for the business', async () => {
    const shipment = await addShipment(1);
    tracking.respond(shipment.trackCode, [
      event('UNKNOWN', '2026-11-01T08:00:00Z', { rawStatus: 'Новый странный статус' }),
    ]);
    const poll = build();

    await poll.execute();
    world.clock.advance(3 * HOUR);
    await poll.execute();

    expect((await world.shipments.findById(shipment.id))?.status).toBe('UNKNOWN');
    const alerts = world.outboxOfType('DEV_ALERT');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ payload: { details: expect.stringContaining('Новый странный статус') } });
    expect(world.outboxOfType('STATUS_CHANGED')).toHaveLength(0);
  });

  it('raises an outage alert when every request in a run fails', async () => {
    for (const n of [1, 2, 3]) {
      const s = await addShipment(n);
      tracking.respond(s.trackCode, new ExternalServiceError('kazpost', 'down'));
    }

    await build().execute();
    await build().execute(); // same hour -> deduplicated

    const alerts = world.outboxOfType('DEV_ALERT');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.dedupKey).toMatch(/^dev:kazpost-down:/);
  });

  it('does not cry outage when only some requests fail', async () => {
    for (const n of [1, 2, 3, 4]) await addShipment(n);
    tracking.respond('RR000000001KZ', new ExternalServiceError('kazpost', 'down'));
    tracking.respond('RR000000002KZ', new ExternalServiceError('kazpost', 'down'));
    tracking.respond('RR000000003KZ', new ExternalServiceError('kazpost', 'down'));

    await build().execute();

    expect(world.outboxOfType('DEV_ALERT')).toHaveLength(0);
  });

  it('is atomic: if the outbox write fails the shipment is not updated either', async () => {
    const shipment = await addShipment(1);
    tracking.respond(shipment.trackCode, [event('IN_TRANSIT', '2026-11-01T08:00:00Z')]);
    world.outbox.enqueue = async () => {
      throw new Error('outbox down');
    };

    const result = await build().execute();

    expect(result.failures).toBe(1);
    expect(await world.shipments.findById(shipment.id)).toMatchObject({ status: 'REGISTERED', crmSyncStatus: 'SYNCED' });
    expect(world.store.events.size).toBe(0);
  });

  it('respects the configured concurrency', async () => {
    for (const n of [1, 2, 3, 4, 5, 6]) await addShipment(n);
    let active = 0;
    let peak = 0;
    tracking.fetchEvents = async (code: string) => {
      tracking.requests.push(code);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return [];
    };

    await build(2).execute();

    expect(peak).toBe(2);
    expect(tracking.requests).toHaveLength(6);
  });
});
