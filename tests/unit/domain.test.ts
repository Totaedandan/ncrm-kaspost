import { describe, expect, it } from 'vitest';
import { decideKazpostOrder } from '../../src/domain/kazpost-filter';
import {
  applyObservation,
  applyPollFailure,
  newShipment,
  resetForNewTrack,
  type Shipment,
} from '../../src/domain/shipment';
import { evaluateStuck } from '../../src/domain/stuck';
import { computeDedupHash } from '../../src/domain/tracking-event';
import { DEFAULT_TRACK_CODE_PATTERN, TrackCode } from '../../src/domain/track-code';
import { InvalidTrackCodeError } from '../../src/domain/errors';
import { isTerminal } from '../../src/domain/tracking-status';
import { T0, event, order } from '../helpers/fakes';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function shipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    ...newShipment({ crmOrderId: '1042', trackCode: 'RR123456789KZ', customerName: 'Иванов И.' }),
    id: 'sh-1',
    createdAt: T0,
    ...overrides,
  };
}

describe('TrackCode', () => {
  it('trims and upper-cases valid codes', () => {
    expect(TrackCode.tryParse('  rr123456789kz ', DEFAULT_TRACK_CODE_PATTERN)?.value).toBe('RR123456789KZ');
  });

  it.each([null, undefined, '', '   ', 'RR12345KZ', '123456789KZRR', 'RR123456789KZX'])(
    'rejects %j',
    (raw) => {
      expect(TrackCode.tryParse(raw, DEFAULT_TRACK_CODE_PATTERN)).toBeNull();
    },
  );

  it('honours a custom pattern', () => {
    expect(TrackCode.tryParse('abc-1', /^ABC-\d$/)?.value).toBe('ABC-1');
  });

  it('parse() throws InvalidTrackCodeError', () => {
    expect(() => TrackCode.parse('nope', DEFAULT_TRACK_CODE_PATTERN)).toThrow(InvalidTrackCodeError);
  });
});

describe('decideKazpostOrder', () => {
  const config = { deliveryValue: 'Казпочта', trackPattern: DEFAULT_TRACK_CODE_PATTERN };

  it('accepts a Kazpost order with a valid track', () => {
    const decision = decideKazpostOrder(order({ id: '1', trackCode: 'rr123456789kz' }), config);
    expect(decision.kind === 'accept' && decision.trackCode.value).toBe('RR123456789KZ');
  });

  it('skips courier orders even when they carry a valid-looking track', () => {
    const decision = decideKazpostOrder(
      order({ id: '1', trackCode: 'RR123456789KZ', deliveryMethod: 'Курьер' }),
      config,
    );
    expect(decision).toEqual({ kind: 'skip', reason: 'NOT_KAZPOST' });
  });

  it('skips orders without a track', () => {
    expect(decideKazpostOrder(order({ id: '1', trackCode: null }), config)).toEqual({
      kind: 'skip',
      reason: 'NO_TRACK',
    });
  });

  it('skips orders with an invalid track', () => {
    expect(decideKazpostOrder(order({ id: '1', trackCode: 'garbage' }), config)).toEqual({
      kind: 'skip',
      reason: 'INVALID_TRACK',
    });
  });

  it('matches the delivery method case-insensitively', () => {
    const decision = decideKazpostOrder(
      order({ id: '1', trackCode: 'RR123456789KZ', deliveryMethod: ' КАЗПОЧТА ' }),
      config,
    );
    expect(decision.kind).toBe('accept');
  });

  it('filters only by track when no delivery method is available', () => {
    const noMethod = { ...config, deliveryValue: '' };
    expect(decideKazpostOrder(order({ id: '1', trackCode: 'RR123456789KZ', deliveryMethod: 'Курьер' }), noMethod).kind).toBe('accept');
    expect(decideKazpostOrder(order({ id: '1', trackCode: 'RR123456789KZ', deliveryMethod: null }), config).kind).toBe('accept');
  });
});

describe('Shipment transitions', () => {
  it('moves REGISTERED -> IN_TRANSIT and flags the CRM sync as pending', () => {
    const result = applyObservation(shipment(), [event('IN_TRANSIT', '2026-11-01T08:00:00Z', { location: 'Алматы' })], T0);

    expect(result.statusChanged).toBe(true);
    expect(result.previousStatus).toBe('REGISTERED');
    expect(result.shipment).toMatchObject({
      status: 'IN_TRANSIT',
      crmSyncStatus: 'PENDING',
      crmSyncAttempts: 0,
      lastLocation: 'Алматы',
      statusChangedAt: new Date('2026-11-01T08:00:00Z'),
      pollErrorCount: 0,
    });
  });

  it('does not mutate its input', () => {
    const original = shipment();
    const snapshot = { ...original };
    applyObservation(original, [event('IN_TRANSIT', '2026-11-01T08:00:00Z')], T0);
    expect(original).toEqual(snapshot);
  });

  it('is idempotent: the same events again report no status change', () => {
    const events = [event('IN_TRANSIT', '2026-11-01T08:00:00Z')];
    const first = applyObservation(shipment(), events, T0);
    const second = applyObservation(first.shipment, events, new Date(T0.getTime() + HOUR));

    expect(second.statusChanged).toBe(false);
    expect(second.shipment.crmSyncStatus).toBe('PENDING'); // untouched until pushed
    expect(second.shipment.status).toBe('IN_TRANSIT');
  });

  it('takes the newest event regardless of list order', () => {
    const result = applyObservation(
      shipment(),
      [event('ARRIVED_AT_OFFICE', '2026-11-01T09:00:00Z'), event('IN_TRANSIT', '2026-10-30T09:00:00Z')],
      T0,
    );
    expect(result.shipment.status).toBe('ARRIVED_AT_OFFICE');
  });

  it('records deliveredAt on DELIVERED', () => {
    const result = applyObservation(shipment({ status: 'ARRIVED_AT_OFFICE' }), [event('DELIVERED', '2026-11-01T09:00:00Z')], T0);
    expect(result.shipment.deliveredAt).toEqual(new Date('2026-11-01T09:00:00Z'));
  });

  it('a parcel that started going back stays RETURNED even when it is later "handed over" to the sender', () => {
    const history = [
      event('ARRIVED_AT_OFFICE', '2026-10-16T09:00:00Z'),
      event('RETURNING', '2026-10-19T06:00:00Z'),
      event('IN_TRANSIT', '2026-10-30T09:00:00Z'),
      event('DELIVERED', '2026-11-03T10:00:00Z'),
    ];

    const result = applyObservation(shipment({ status: 'IN_TRANSIT' }), history, T0);

    expect(result.statusChanged).toBe(true);
    expect(result.shipment).toMatchObject({ status: 'RETURNED', crmSyncStatus: 'PENDING', deliveredAt: null });
  });

  it('a return is dated by the moment it was noticed, and is terminal afterwards', () => {
    const history = [event('RETURNING', '2026-10-19T06:00:00Z'), event('IN_TRANSIT', '2026-10-30T09:00:00Z')];

    const first = applyObservation(shipment({ status: 'IN_TRANSIT' }), history, T0);
    const again = applyObservation(first.shipment, [...history, event('DELIVERED', '2026-11-03T10:00:00Z')], new Date(T0.getTime() + DAY));

    expect(first.shipment.statusChangedAt).toEqual(T0);
    expect(again.statusChanged).toBe(false);
    expect(again.shipment.status).toBe('RETURNED');
  });

  it('a plain delivery without any return event is still DELIVERED', () => {
    const history = [event('ARRIVED_AT_OFFICE', '2026-11-01T09:00:00Z'), event('DELIVERED', '2026-11-02T09:00:00Z')];
    expect(applyObservation(shipment({ status: 'ARRIVED_AT_OFFICE' }), history, T0).shipment.status).toBe('DELIVERED');
  });

  it.each(['DELIVERED', 'RETURNED'] as const)('never leaves terminal status %s', (status) => {
    const result = applyObservation(shipment({ status }), [event('IN_TRANSIT', '2026-11-01T09:00:00Z')], T0);
    expect(result.statusChanged).toBe(false);
    expect(result.shipment.status).toBe(status);
  });

  it('empty history only refreshes the check bookkeeping', () => {
    const result = applyObservation(shipment(), [], T0);
    expect(result.statusChanged).toBe(false);
    expect(result.shipment.status).toBe('REGISTERED');
    expect(result.shipment.lastCheckedAt).toEqual(T0);
  });

  it('a failed poll is counted and keeps the status', () => {
    const failed = applyPollFailure(shipment(), T0);
    expect(failed.pollErrorCount).toBe(1);
    expect(failed.status).toBe('REGISTERED');
    expect(failed.lastCheckedAt).toEqual(T0);
  });

  it('a new track code resets the tracking state', () => {
    const delivered = shipment({ status: 'DELIVERED', crmSyncStatus: 'SYNCED', stuckAlertSentAt: T0, lastEventAt: T0 });
    const reset = resetForNewTrack(delivered, 'RR999999999KZ');
    expect(reset).toMatchObject({
      trackCode: 'RR999999999KZ',
      status: 'REGISTERED',
      lastEventAt: null,
      stuckAlertSentAt: null,
      id: 'sh-1',
    });
  });
});

describe('isTerminal', () => {
  it('only DELIVERED and RETURNED stop polling', () => {
    expect(['DELIVERED', 'RETURNED'].every((s) => isTerminal(s as never))).toBe(true);
    expect(['REGISTERED', 'IN_TRANSIT', 'ARRIVED_AT_OFFICE', 'RETURNING', 'UNKNOWN'].some((s) => isTerminal(s as never))).toBe(false);
  });
});

describe('evaluateStuck', () => {
  const config = { stuckInOfficeDays: 5, noUpdatesDays: 10 };

  it('flags a parcel waiting in the office for 5+ days', () => {
    const s = shipment({ status: 'ARRIVED_AT_OFFICE', statusChangedAt: new Date(T0.getTime() - 5 * DAY), lastEventAt: new Date(T0.getTime() - 5 * DAY) });
    expect(evaluateStuck(s, T0, config)).toEqual({ reason: 'IN_OFFICE', days: 5 });
  });

  it('does not flag 4 days in the office', () => {
    const s = shipment({ status: 'ARRIVED_AT_OFFICE', statusChangedAt: new Date(T0.getTime() - 4 * DAY), lastEventAt: new Date(T0.getTime() - 4 * DAY) });
    expect(evaluateStuck(s, T0, config)).toBeNull();
  });

  it('flags 10+ days without events', () => {
    const s = shipment({ status: 'IN_TRANSIT', lastEventAt: new Date(T0.getTime() - 11 * DAY) });
    expect(evaluateStuck(s, T0, config)).toEqual({ reason: 'NO_UPDATES', days: 11 });
  });

  it('ignores terminal shipments', () => {
    const s = shipment({ status: 'DELIVERED', lastEventAt: new Date(T0.getTime() - 30 * DAY) });
    expect(evaluateStuck(s, T0, config)).toBeNull();
  });
});

describe('computeDedupHash', () => {
  const base = event('IN_TRANSIT', '2026-11-01T08:00:00Z', { rawStatus: 'В пути', location: 'Алматы' });

  it('is stable and depends on track, raw status, time and location', () => {
    const hash = computeDedupHash('RR1', base);
    expect(computeDedupHash('RR1', { ...base })).toBe(hash);
    expect(computeDedupHash('RR2', base)).not.toBe(hash);
    expect(computeDedupHash('RR1', { ...base, rawStatus: 'Другое' })).not.toBe(hash);
    expect(computeDedupHash('RR1', { ...base, location: null })).not.toBe(hash);
    expect(computeDedupHash('RR1', { ...base, occurredAt: new Date('2026-11-01T08:00:01Z') })).not.toBe(hash);
  });
});
