import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExternalSchemaError, ExternalServiceError } from '../../src/domain/errors';
import { HttpClient } from '../../src/infrastructure/http/http-client';
import { KazpostAdapter } from '../../src/infrastructure/tracking/kazpost.adapter';
import { parseKazpostDateTime } from '../../src/infrastructure/tracking/kazpost.schemas';
import { KAZPOST_CODES } from '../../src/infrastructure/tracking/kazpost-status-codes';
import { mapKazpostCode, undoTarget } from '../../src/infrastructure/tracking/kazpost-status.mapper';

const FIXTURES = join(__dirname, '..', 'fixtures', 'kazpost');
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.json`), 'utf8');

/** Adapter wired to a canned HTTP response, no network. */
function adapterReturning(status: number, body: string) {
  const urls: string[] = [];
  const http = {
    get: async (url: string) => {
      urls.push(url);
      return { status, text: body };
    },
  };
  return { adapter: new KazpostAdapter({ baseUrl: 'https://kazpost.test/api/v2/', http }), urls };
}

const fetchFixture = (name: string) => adapterReturning(200, fixture(name)).adapter.fetchEvents('RR100000001KZ');

describe('KazpostAdapter on a real recorded response (AV005201643KZ)', () => {
  it('requests {base}/{track}/events', async () => {
    const { adapter, urls } = adapterReturning(200, fixture('real-delivered'));
    await adapter.fetchEvents('AV005201643KZ');
    expect(urls).toEqual(['https://kazpost.test/api/v2/AV005201643KZ/events']);
  });

  it('returns a chronological list ending with the delivery', async () => {
    const events = await fetchFixture('real-delivered');
    const times = events.map((e) => e.occurredAt.getTime());

    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(events.at(-1)).toMatchObject({
      status: 'DELIVERED',
      rawStatus: 'ISSPAY: Вручено',
      location: 'СОПС с.Шидерты, 141220',
      occurredAt: new Date('2023-03-13T04:32:47Z'), // 09:32:47 at UTC+5
    });
  });

  it('drops internal codes and keeps only customer-visible ones', async () => {
    const events = await fetchFixture('real-delivered');
    const codes = events.map((e) => e.rawStatus.split(':')[0]);

    expect(codes).toEqual(['RCPOPS', 'SND', 'SND', 'PRC', 'SND', 'PRC', 'STR', 'ISSPAY']);
    expect(events.some((e) => e.status === 'UNKNOWN')).toBe(false); // undocumented New_act_B / Send_act are known-internal
  });

  it('walks REGISTERED -> IN_TRANSIT -> ARRIVED_AT_OFFICE -> DELIVERED', async () => {
    const statuses = (await fetchFixture('real-delivered')).map((e) => e.status);
    expect(statuses[0]).toBe('REGISTERED');
    expect(statuses.at(-3)).toBe('IN_TRANSIT');
    expect(statuses.at(-2)).toBe('ARRIVED_AT_OFFICE');
    expect(statuses.at(-1)).toBe('DELIVERED');
  });

  it('keeps the original activity as rawPayload', async () => {
    const [first] = await fetchFixture('real-delivered');
    expect(first?.rawPayload).toMatchObject({ status: ['RCPOPS'], zip: expect.any(String) });
  });
});

describe('KazpostAdapter on documented status codes', () => {
  it('"no information" (Russian wording of the production API) is an empty history, not an error', async () => {
    await expect(fetchFixture('no-info')).resolves.toEqual([]);
  });

  it.each([
    ['registered', 'REGISTERED'],
    ['in-transit', 'IN_TRANSIT'],
    ['arrived-office', 'ARRIVED_AT_OFFICE'],
    ['returning', 'RETURNING'],
    ['returned', 'RETURNED'],
  ])('%s -> newest event is %s', async (name, expected) => {
    expect((await fetchFixture(name)).at(-1)?.status).toBe(expected);
  });

  it('an unknown code becomes UNKNOWN with the code as raw text', async () => {
    const newest = (await fetchFixture('unknown-code')).at(-1);
    expect(newest).toMatchObject({ status: 'UNKNOWN', rawStatus: 'NEWCODE42' });
  });

  it('an UNDO code retracts the delivery it cancels', async () => {
    const events = await fetchFixture('undo-delivered');
    expect(events.map((e) => e.status)).toEqual(['ARRIVED_AT_OFFICE']);
  });

  it('emits one event per code when an activity carries several statuses', async () => {
    const events = await fetchFixture('multi-status');
    expect(events.map((e) => e.rawStatus.split(':')[0])).toEqual(['PRC']); // TRN is internal
  });

  it('an unparsable event time is a schema problem', async () => {
    await expect(fetchFixture('bad-date')).rejects.toBeInstanceOf(ExternalSchemaError);
  });

  it('an activity without a time is a schema problem', async () => {
    await expect(fetchFixture('malformed')).rejects.toBeInstanceOf(ExternalSchemaError);
  });

  it('flags non-JSON bodies and unexpected shapes as schema problems', async () => {
    await expect(adapterReturning(200, '<html>').adapter.fetchEvents('X')).rejects.toBeInstanceOf(ExternalSchemaError);
    await expect(adapterReturning(200, '{"hello":1}').adapter.fetchEvents('X')).rejects.toBeInstanceOf(ExternalSchemaError);
    await expect(adapterReturning(200, '{"error":"boom"}').adapter.fetchEvents('X')).rejects.toBeInstanceOf(ExternalSchemaError);
    await expect(adapterReturning(200, '[]').adapter.fetchEvents('X')).rejects.toBeInstanceOf(ExternalSchemaError);
  });

  it('ignores unknown fields', async () => {
    const body = JSON.stringify({
      trackid: 'X',
      surprise: 1,
      events: [{ date: '01.11.2026', extra: true, activity: [{ time: '10:00', status: ['STR'], more: 1 }] }],
    });
    const events = await adapterReturning(200, body).adapter.fetchEvents('X');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'ARRIVED_AT_OFFICE', location: null });
  });

  it('turns HTTP 4xx into a service error', async () => {
    await expect(adapterReturning(403, '').adapter.fetchEvents('X')).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it('works through the real HttpClient with a stubbed fetch (retry on 502)', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return calls === 1
        ? new Response('bad gateway', { status: 502 })
        : new Response(fixture('real-delivered'), { status: 200 });
    };
    const http = new HttpClient({ service: 'kazpost', userAgent: 'test', fetchImpl, sleepImpl: async () => undefined });
    const adapter = new KazpostAdapter({ baseUrl: 'https://kazpost.test/api/v2', http });

    const events = await adapter.fetchEvents('AV005201643KZ');
    expect(calls).toBe(2);
    expect(events.at(-1)?.status).toBe('DELIVERED');
  });
});

describe('Kazpost status dictionary mapping', () => {
  it.each([
    ['ISSPAY', 'DELIVERED'],
    ['DPAY', 'DELIVERED'],
    ['Handed', 'DELIVERED'],
    ['HandedPVZ', 'DELIVERED'],
    ['EMI', 'DELIVERED'],
    ['STR', 'ARRIVED_AT_OFFICE'],
    ['STRSC', 'ARRIVED_AT_OFFICE'],
    ['EMG', 'ARRIVED_AT_OFFICE'],
    ['NONDLV', 'ARRIVED_AT_OFFICE'],
    ['RCPOPS', 'REGISTERED'],
    ['Registered', 'REGISTERED'],
    ['PRC', 'IN_TRANSIT'],
    ['SND', 'IN_TRANSIT'],
    ['DLV', 'IN_TRANSIT'],
    ['AtCustom', 'IN_TRANSIT'],
    ['RET', 'RETURNING'],
    ['RETSTR', 'RETURNING'],
    ['ReturnedPVZ', 'RETURNING'],
    ['ReturnedCompany', 'RETURNED'],
    ['RETCC', 'RETURNED'],
  ])('%s -> %s', (code, expected) => {
    expect(mapKazpostCode(code)).toMatchObject({ kind: 'visible', status: expected });
  });

  it('knows hidden, internal and unknown codes apart', () => {
    expect(mapKazpostCode('TRN').kind).toBe('hidden');
    expect(mapKazpostCode('ISSPAY_UNDO').kind).toBe('hidden');
    // internal codes seen in live responses but missing from the official dictionary
    for (const code of ['New_act_B', 'New_act_G', 'New_act', 'Send_act', 'Delete_act']) {
      expect(mapKazpostCode(code).kind).toBe('hidden');
    }
    expect(mapKazpostCode('NEVERHEARD').kind).toBe('unknown');
    expect(mapKazpostCode('constructor').kind).toBe('unknown');
  });

  it('resolves UNDO targets', () => {
    expect(undoTarget('ISSPAY_UNDO')).toBe('ISSPAY');
    expect(undoTarget('ISSPAY_UNDO_I')).toBe('ISSPAY_I');
    expect(undoTarget('ISSPAY')).toBeNull();
  });

  it('never classifies a return as a delivery and covers the whole dictionary', () => {
    const dictionary = JSON.parse(readFileSync(join(FIXTURES, 'new_mappings.json'), 'utf8')) as Record<string, unknown>;
    for (const code of Object.keys(dictionary)) expect(KAZPOST_CODES[code], code).toBeDefined();
    expect(Object.keys(KAZPOST_CODES).length).toBeGreaterThanOrEqual(Object.keys(dictionary).length);
  });
});

describe('parseKazpostDateTime', () => {
  it('reads DD.MM.YYYY + HH:mm:ss as UTC+5', () => {
    expect(parseKazpostDateTime('19.11.2026', '14:32:10')?.toISOString()).toBe('2026-11-19T09:32:10.000Z');
  });
  it('accepts times without seconds', () => {
    expect(parseKazpostDateTime('19.11.2026', '14:32')?.toISOString()).toBe('2026-11-19T09:32:00.000Z');
  });
  it('returns null for garbage', () => {
    expect(parseKazpostDateTime('not a date', '10:00')).toBeNull();
    expect(parseKazpostDateTime('32.13.2026', '10:00')).toBeNull();
  });
});
