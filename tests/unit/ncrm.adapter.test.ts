import { describe, expect, it } from 'vitest';
import { CRM_CURSOR_KEY, SyncShipmentsFromCrm } from '../../src/application/use-cases/sync-shipments-from-crm';
import { loadEnv } from '../../src/config/env';
import { DEFAULT_TRACK_CODE_PATTERN } from '../../src/domain/track-code';
import { createSilentLogger } from '../../src/shared/logger';
import { createWorld } from '../helpers/fakes';
import { ExternalSchemaError, ExternalServiceError } from '../../src/domain/errors';
import { NcrmAdapter, normalizeOrigin } from '../../src/infrastructure/crm/ncrm.adapter';
import { fieldIdOf, newestTrackInNotes, toSearchPattern, valueToText } from '../../src/infrastructure/crm/ncrm.schemas';
import { HttpClient, type HttpRequest } from '../../src/infrastructure/http/http-client';

const TOKEN = 'SECRET-TOKEN-123';
const TRACK_FIELD = 11;
const DELIVERY_FIELD = 12;

interface Call {
  url: string;
  request: HttpRequest;
}

/** Scripted NCRM: answers requests in order and records them. */
function setup(responses: Array<{ status?: number; body?: unknown } | string>, overrides: { deliveryFieldId?: number | null } = {}) {
  const calls: Call[] = [];
  let index = 0;
  const http = {
    request: async (url: string, request: HttpRequest = {}) => {
      calls.push({ url, request });
      const next = responses[index++] ?? { status: 200, body: [] };
      if (typeof next === 'string') return { status: 200, text: next };
      return { status: next.status ?? 200, text: next.body === undefined ? '' : JSON.stringify(next.body) };
    },
  };
  const adapter = new NcrmAdapter({
    baseUrl: 'cloud.ncrm.pro/',
    apiKey: TOKEN,
    trackFieldId: TRACK_FIELD,
    deliveryFieldId: overrides.deliveryFieldId === undefined ? DELIVERY_FIELD : overrides.deliveryFieldId,
    http,
  });
  return { adapter, calls };
}

const deal = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  changed: '2026-10-31T10:00:00.123456',
  created: '2026-10-01T10:00:00',
  full_name: `Сделка ${id}`,
  stage_id: 7,
  contact: { full_name: 'Иванов И.' },
  field_values: [
    { field: TRACK_FIELD, value: 'rr123456789kz' },
    { field: DELIVERY_FIELD, value: 'Казпочта' },
  ],
  ...extra,
});

async function collect(iterable: AsyncIterable<{ orders: unknown[] }>) {
  const orders: unknown[] = [];
  for await (const page of iterable) orders.push(...page.orders);
  return orders;
}

describe('NcrmAdapter.listOrdersUpdatedSince', () => {
  it('maps a deal to a CRM order using the configured custom fields', async () => {
    const { adapter, calls } = setup([{ body: [deal(1042)] }]);

    const orders = await collect(adapter.listOrdersUpdatedSince(null));

    expect(orders).toEqual([
      {
        id: '1042',
        trackCode: 'rr123456789kz',
        deliveryMethod: 'Казпочта',
        status: '7',
        customerName: 'Иванов И.',
        updatedAt: new Date('2026-10-31T10:00:00.123456'),
      },
    ]);
    expect(calls[0]?.url).toBe(`https://cloud.ncrm.pro/api/deals/?api_token=${TOKEN}`);
    expect(calls[0]?.request.headers).toMatchObject({ referer: 'https://cloud.ncrm.pro/' });
  });

  it('filters by the cursor on the client side (the API has no such filter)', async () => {
    const { adapter } = setup([
      { body: [deal(1, { changed: '2026-10-30T00:00:00' }), deal(2, { changed: '2026-10-31T10:00:00' }), deal(3, { changed: '2026-11-01T00:00:00' })] },
    ]);

    const orders = (await collect(adapter.listOrdersUpdatedSince(new Date('2026-10-31T10:00:00').toISOString()))) as Array<{ id: string }>;

    expect(orders.map((o) => o.id)).toEqual(['2', '3']); // boundary included
  });

  it('reads the contact from an array and survives a missing contact', async () => {
    const { adapter } = setup([{ body: [deal(1, { contact: [{ full_name: 'Петрова А.' }] }), deal(2, { contact: null })] }]);
    const orders = (await collect(adapter.listOrdersUpdatedSince(null))) as Array<{ customerName?: string }>;
    expect(orders[0]?.customerName).toBe('Петрова А.');
    expect(orders[1]).not.toHaveProperty('customerName');
  });

  it('returns null track / delivery when the custom fields are absent or empty', async () => {
    const { adapter } = setup([{ body: [deal(1, { field_values: [{ field: TRACK_FIELD, value: '  ' }] }), deal(2, { field_values: null })] }]);
    const orders = (await collect(adapter.listOrdersUpdatedSince(null))) as Array<{ trackCode: string | null; deliveryMethod: string | null }>;
    expect(orders.map((o) => [o.trackCode, o.deliveryMethod])).toEqual([[null, null], [null, null]]);
  });

  it('ignores the delivery field when none is configured', async () => {
    const { adapter } = setup([{ body: [deal(1)] }], { deliveryFieldId: null });
    const [order] = (await collect(adapter.listOrdersUpdatedSince(null))) as Array<{ deliveryMethod: string | null }>;
    expect(order?.deliveryMethod).toBeNull();
  });

  it('follows DRF-style pages, stays on the NCRM host and keeps the token', async () => {
    const { adapter, calls } = setup([
      { body: { results: [deal(1)], next: 'https://cloud.ncrm.pro/api/deals/?page=2' } },
      { body: { results: [deal(2)], next: null } },
    ]);

    const orders = (await collect(adapter.listOrdersUpdatedSince(null))) as Array<{ id: string }>;

    expect(orders.map((o) => o.id)).toEqual(['1', '2']);
    expect(calls[1]?.url).toBe(`https://cloud.ncrm.pro/api/deals/?page=2&api_token=${TOKEN}`);
  });

  it('refuses a pagination link to another host (the token would leak)', async () => {
    const { adapter } = setup([{ body: { results: [deal(1)], next: 'https://evil.example/api/deals/?page=2' } }]);
    await expect(collect(adapter.listOrdersUpdatedSince(null))).rejects.toBeInstanceOf(ExternalSchemaError);
  });

  it('detects a pagination loop', async () => {
    const page = { body: { results: [], next: 'https://cloud.ncrm.pro/api/deals/' } };
    const { adapter } = setup([page, page, page]);
    await expect(collect(adapter.listOrdersUpdatedSince(null))).rejects.toThrow(/does not terminate/);
  });

  it('reports schema problems with the shape only, never the customer data', async () => {
    const { adapter } = setup([{ body: [{ id: 5, changed: 'garbage', full_name: 'Секретный Клиент', field_values: [] }] }]);
    const error = await collect(adapter.listOrdersUpdatedSince(null)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExternalSchemaError);
    expect((error as ExternalSchemaError).sample).toContain('keys:');
    expect(JSON.stringify(error)).not.toContain('Секретный');
    expect((error as ExternalSchemaError).message).not.toContain(TOKEN);
  });

  it('rejects unexpected list shapes and non-JSON', async () => {
    await expect(collect(setup([{ body: { hello: 1 } }]).adapter.listOrdersUpdatedSince(null))).rejects.toBeInstanceOf(ExternalSchemaError);
    await expect(collect(setup(['<html>']).adapter.listOrdersUpdatedSince(null))).rejects.toBeInstanceOf(ExternalSchemaError);
  });

  it('turns HTTP errors into service errors without leaking the token', async () => {
    const { adapter } = setup([{ status: 401 }]);
    const error = await collect(adapter.listOrdersUpdatedSince(null)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as Error).message).toContain('NCRM_API_KEY');
    expect((error as Error).message).not.toContain(TOKEN);
  });
});

describe('NcrmAdapter writes', () => {
  it('changes the stage through PATCH /api/deals/change_stage/', async () => {
    const { adapter, calls } = setup([{ status: 204 }]);

    await adapter.updateOrderStatus('1042', '15');

    expect(calls[0]?.url).toBe(`https://cloud.ncrm.pro/api/deals/change_stage/?api_token=${TOKEN}`);
    expect(calls[0]?.request).toMatchObject({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', referer: 'https://cloud.ncrm.pro/' },
    });
    expect(JSON.parse(String(calls[0]?.request.body))).toEqual({ stage_id: 15, ids: [1042] });
  });

  it('fails when the stage change is rejected', async () => {
    const { adapter } = setup([{ status: 400 }]);
    await expect(adapter.updateOrderStatus('1', '2')).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it('posts a comment as multipart with a JSON message and no retries', async () => {
    const { adapter, calls } = setup([{ status: 201 }]);

    await adapter.addOrderComment('1042', 'Казпочта: Вручено');

    const request = calls[0]?.request;
    expect(calls[0]?.url).toBe(`https://cloud.ncrm.pro/api/notes/deals/1042/?api_token=${TOKEN}`);
    expect(request?.method).toBe('POST');
    expect(request?.retries).toBe(0);
    expect(request?.headers).not.toHaveProperty('Content-Type'); // the multipart boundary is set by fetch
    expect(JSON.parse(String((request?.body as FormData).get('text')))).toEqual({ message: 'Казпочта: Вручено' });
  });

  it('fails when the comment is rejected', async () => {
    const { adapter } = setup([{ status: 404 }]);
    await expect(adapter.addOrderComment('1', 'x')).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

describe('NcrmAdapter through the real HttpClient', () => {
  it('never puts the token into error messages, even when the network fails', async () => {
    const http = new HttpClient({
      service: 'ncrm',
      userAgent: 'test',
      retries: 1,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
      sleepImpl: async () => undefined,
    });
    const adapter = new NcrmAdapter({ baseUrl: 'https://cloud.ncrm.pro', apiKey: TOKEN, trackFieldId: 1, deliveryFieldId: null, http });

    const error = await collect(adapter.listOrdersUpdatedSince(null)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('sends method, body and headers, and does not retry when retries is 0', async () => {
    let calls = 0;
    let seen: RequestInit | undefined;
    const http = new HttpClient({
      service: 'ncrm',
      userAgent: 'ua',
      fetchImpl: async (_url, init) => {
        calls += 1;
        seen = init;
        return new Response('', { status: 500 });
      },
      sleepImpl: async () => undefined,
    });

    await expect(http.request('https://x.test', { method: 'POST', body: '{}', headers: { referer: 'r' }, retries: 0 })).rejects.toBeInstanceOf(ExternalServiceError);

    expect(calls).toBe(1);
    expect(seen).toMatchObject({ method: 'POST', body: '{}', headers: { 'User-Agent': 'ua', referer: 'r' } });
  });
});

describe('NCRM helpers', () => {
  it('normalizes the account host', () => {
    expect(normalizeOrigin('cloud.ncrm.pro')).toBe('https://cloud.ncrm.pro');
    expect(normalizeOrigin('https://acme.ncrm.kz/api/')).toBe('https://acme.ncrm.kz');
    expect(normalizeOrigin('http://localhost:8000/')).toBe('http://localhost:8000');
  });

  it.each([
    [{ field: 5 }, '5'],
    [{ field: '5' }, '5'],
    [{ field_id: 5 }, '5'],
    [{ field: { id: 5, field_name: 'Трек' } }, '5'],
    [{ id: 99 }, null],
  ])('finds the field id in %j', (entry, expected) => {
    expect(fieldIdOf(entry)).toBe(expected);
  });

  it.each([
    ['  Казпочта ', 'Казпочта'],
    [42, '42'],
    [['A', 'B'], 'A, B'],
    [{ id: 3, name: 'Казпочта' }, 'Казпочта'],
    [{ value: 'X' }, 'X'],
    ['', null],
    [null, null],
    [{}, null],
  ])('renders %j as text', (value, expected) => {
    expect(valueToText(value)).toBe(expected);
  });
});

describe('NCRM environment validation', () => {
  const base = {
    DATABASE_URL: 'postgresql://x',
    CRM_DRIVER: 'ncrm',
    NCRM_BASE_URL: 'cloud.ncrm.pro',
    NCRM_API_KEY: 'k',
    NCRM_SOURCE_STAGE_ID: '5',
    CRM_STATUS_MAP: '{"DELIVERED":"9"}',
  };

  it('requires the source stage and the DELIVERED target stage for the ncrm driver', () => {
    expect(() => loadEnv({ ...base, NCRM_SOURCE_STAGE_ID: '' })).toThrow(/NCRM_SOURCE_STAGE_ID/);
    expect(() => loadEnv({ ...base, CRM_STATUS_MAP: '{}' })).toThrow(/CRM_STATUS_MAP/);
    expect(loadEnv(base)).toMatchObject({ NCRM_SOURCE_STAGE_ID: 5, NCRM_TRACK_SOURCE: 'comments' });
  });

  it('requires the track field id only when tracks come from a custom field', () => {
    expect(() => loadEnv({ ...base, NCRM_TRACK_SOURCE: 'field' })).toThrow(/NCRM_TRACK_FIELD_ID/);
    expect(loadEnv({ ...base, NCRM_TRACK_SOURCE: 'field', NCRM_TRACK_FIELD_ID: '11' }).NCRM_TRACK_FIELD_ID).toBe(11);
  });

  it('requires a delivery field when a delivery value is configured', () => {
    expect(() => loadEnv({ ...base, NCRM_KAZPOST_DELIVERY_VALUE: 'Казпочта' })).toThrow(/NCRM_DELIVERY_FIELD_ID/);
    expect(loadEnv({ ...base, NCRM_DELIVERY_FIELD_ID: '12', NCRM_KAZPOST_DELIVERY_VALUE: 'Казпочта' }).NCRM_DELIVERY_FIELD_ID).toBe(12);
  });

  it('parses the pilot deal id list', () => {
    expect(loadEnv({ ...base, NCRM_ONLY_DEAL_IDS: '7350332, 7350333' }).NCRM_ONLY_DEAL_IDS).toEqual(['7350332', '7350333']);
    expect(loadEnv(base).NCRM_ONLY_DEAL_IDS).toEqual([]);
    expect(() => loadEnv({ ...base, NCRM_ONLY_DEAL_IDS: 'abc' })).toThrow(/NCRM_ONLY_DEAL_IDS/);
  });

  it('rejects non-numeric field ids and leaves them null for the mock driver', () => {
    expect(() => loadEnv({ ...base, NCRM_TRACK_FIELD_ID: 'abc' })).toThrow(/NCRM_TRACK_FIELD_ID/);
    expect(loadEnv({ DATABASE_URL: 'postgresql://x' }).NCRM_TRACK_FIELD_ID).toBeNull();
  });
});

/** NCRM that answers by URL: deals list, per-deal comments and per-deal reads. */
function setupRouted(
  routes: { deals: unknown[]; notes: Record<string, unknown[] | number>; deal?: Record<string, unknown> },
  options: { only?: string[] } = {},
) {
  const urls: string[] = [];
  const http = {
    request: async (url: string) => {
      urls.push(url);
      const path = new URL(url).pathname;
      const notes = /^\/api\/notes\/deals\/(\d+)\/$/.exec(path);
      if (notes) {
        const answer = routes.notes[notes[1] ?? ''];
        if (typeof answer === 'number') return { status: answer, text: '' };
        return { status: 200, text: JSON.stringify(answer ?? []) };
      }
      const single = /^\/api\/deals\/(\d+)\/$/.exec(path);
      if (single) {
        const found = routes.deal?.[single[1] ?? ''];
        return found === undefined ? { status: 404, text: '' } : { status: 200, text: JSON.stringify(found) };
      }
      return { status: 200, text: JSON.stringify(routes.deals) };
    },
  };
  const adapter = new NcrmAdapter({
    baseUrl: 'cloud.ncrm.pro',
    apiKey: TOKEN,
    trackFieldId: null,
    deliveryFieldId: null,
    sourceStageId: '7',
    onlyOrderIds: options.only ? new Set(options.only) : null,
    trackCommentPattern: DEFAULT_TRACK_CODE_PATTERN,
    http,
  });
  return { adapter, urls };
}

const plainDeal = (id: number, extra: Record<string, unknown> = {}) => deal(id, { field_values: [], ...extra });

describe('NcrmAdapter with the track in comments and a source stage', () => {
  it('returns only deals of the source stage, with the track taken from the comment', async () => {
    const { adapter } = setupRouted({
      deals: [plainDeal(1), plainDeal(2, { stage_id: 9 }), plainDeal(3)],
      notes: {
        '1': [{ id: 1, created: '2026-11-02T11:56:00', text: 'UQ058702081KZ' }],
        '3': [{ id: 2, created: '2026-11-02T11:00:00', text: 'позвонили клиенту' }],
      },
    });

    const orders = (await collect(adapter.listOrdersUpdatedSince(null))) as Array<{ id: string; trackCode: string | null }>;

    expect(orders.map((o) => [o.id, o.trackCode])).toEqual([['1', 'UQ058702081KZ'], ['3', null]]);
  });

  it('ignores the cursor: a new comment does not move `changed`', async () => {
    const { adapter } = setupRouted({
      deals: [plainDeal(1, { changed: '2026-10-01T00:00:00' })],
      notes: { '1': [{ text: 'UQ058702081KZ' }] },
    });

    const orders = await collect(adapter.listOrdersUpdatedSince(new Date('2026-11-01T00:00:00').toISOString()));

    expect(orders).toHaveLength(1);
  });

  it('does not read comments when the custom field already gave a track', async () => {
    const urls: string[] = [];
    const adapter = new NcrmAdapter({
      baseUrl: 'cloud.ncrm.pro',
      apiKey: TOKEN,
      trackFieldId: 11,
      deliveryFieldId: null,
      sourceStageId: '7',
      trackCommentPattern: DEFAULT_TRACK_CODE_PATTERN,
      http: {
        request: async (url: string) => {
          urls.push(url);
          return { status: 200, text: JSON.stringify([deal(1, { field_values: [{ field: 11, value: 'RR123456789KZ' }] })]) };
        },
      },
    });

    const [order] = (await collect(adapter.listOrdersUpdatedSince(null))) as Array<{ trackCode: string | null }>;

    expect(order?.trackCode).toBe('RR123456789KZ');
    expect(urls.some((u) => u.includes('/api/notes/'))).toBe(false);
  });

  it('picks the newest comment that carries a track, finds it in JSON text and lower case', async () => {
    const { adapter } = setupRouted({
      deals: [plainDeal(1)],
      notes: {
        '1': [
          { created: '2026-11-02T12:00:00', text: JSON.stringify({ message: 'трек: uq058702081kz.' }) },
          { created: '2026-11-01T12:00:00', text: 'RR123456789KZ' },
        ],
      },
    });

    const [order] = (await collect(adapter.listOrdersUpdatedSince(null))) as Array<{ trackCode: string | null }>;

    expect(order?.trackCode).toBe('UQ058702081KZ');
  });

  it('does not take a track out of a longer token', async () => {
    const { adapter } = setupRouted({ deals: [plainDeal(1)], notes: { '1': [{ text: 'XUQ058702081KZZ and 1UQ058702081KZ' }] } });
    const [order] = (await collect(adapter.listOrdersUpdatedSince(null))) as Array<{ trackCode: string | null }>;
    expect(order?.trackCode).toBeNull();
  });

  it('fails loudly when the comments cannot be read', async () => {
    const broken = setupRouted({ deals: [plainDeal(1)], notes: { '1': 403 } });
    await expect(collect(broken.adapter.listOrdersUpdatedSince(null))).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

describe('NcrmAdapter against the real NCRM response shapes', () => {
  it('reads the stage from the {id, stage_name} object the list endpoint returns, and asks NCRM to filter by stage', async () => {
    const stage = { id: 7, stage_name: 'НА ДОСТАВКЕ', stage_color: '#78BDC4', finish_status: null };
    const { adapter, urls } = setupRouted({
      deals: [plainDeal(1, { stage_id: stage }), plainDeal(2, { stage_id: { ...stage, id: 9 } })],
      notes: { '1': [{ text: 'UQ058702081KZ' }] },
    });

    const orders = (await collect(adapter.listOrdersUpdatedSince(null))) as Array<{ id: string; status: string }>;

    expect(orders.map((o) => [o.id, o.status])).toEqual([['1', '7']]);
    expect(urls[0]).toContain('stage=7');
  });

  it('in a pilot returns only the listed deals and never reads comments of the others', async () => {
    const { adapter, urls } = setupRouted(
      { deals: [plainDeal(1), plainDeal(2), plainDeal(3)], notes: { '1': [{ text: 'UQ058702081KZ' }], '2': [{ text: 'RR123456789KZ' }] } },
      { only: ['2'] },
    );

    const orders = (await collect(adapter.listOrdersUpdatedSince(null))) as Array<{ id: string; trackCode: string | null }>;

    expect(orders.map((o) => [o.id, o.trackCode])).toEqual([['2', 'RR123456789KZ']]);
    expect(urls.filter((u) => u.includes('/api/notes/'))).toHaveLength(1);
    expect(urls.some((u) => u.includes('/api/notes/deals/1/'))).toBe(false);
  });

  it('orders comments by created_date, the key NCRM really uses', async () => {
    const { adapter } = setupRouted({
      deals: [plainDeal(1)],
      notes: {
        '1': [
          { id: 2, created_date: '2026-11-02T06:56:44', text: 'UQ058702081KZ' },
          { id: 1, created_date: '2026-11-01T10:00:00', text: 'RR123456789KZ' },
        ],
      },
    });
    const [order] = (await collect(adapter.listOrdersUpdatedSince(null))) as Array<{ trackCode: string | null }>;
    expect(order?.trackCode).toBe('UQ058702081KZ');
  });
});

describe('NcrmAdapter.getOrderStatus', () => {
  it('returns the current stage id, or null for a deleted deal', async () => {
    const { adapter } = setupRouted({ deals: [], notes: {}, deal: { '5': deal(5, { stage_id: 9 }) } });
    expect(await adapter.getOrderStatus('5')).toBe('9');
    expect(await adapter.getOrderStatus('6')).toBeNull();
  });
});

describe('track search helpers', () => {
  it('turns the anchored track pattern into a boundary-guarded search pattern', () => {
    const search = toSearchPattern(DEFAULT_TRACK_CODE_PATTERN);
    expect('Адилет UQ058702081KZ готово'.match(search)).toEqual(['UQ058702081KZ']);
    expect('XUQ058702081KZ'.match(search)).toBeNull();
  });

  it('prefers the newest dated comment, else the last one', () => {
    const search = toSearchPattern(DEFAULT_TRACK_CODE_PATTERN);
    const dated = [{ created: '2026-11-02T00:00:00', text: 'AA111111111KZ' }, { created: '2026-11-01T00:00:00', text: 'BB222222222KZ' }];
    expect(newestTrackInNotes(dated, search)).toBe('AA111111111KZ');
    expect(newestTrackInNotes([{ text: 'AA111111111KZ' }, { text: 'BB222222222KZ' }], search)).toBe('BB222222222KZ');
    expect(newestTrackInNotes([{ text: 'нет трека' }], search)).toBeNull();
  });
});

describe('courier deals (no track in the comments)', () => {
  it('are skipped silently: no shipment, no warning, nothing written to the CRM', async () => {
    const { adapter, urls } = setupRouted({
      deals: [plainDeal(1), plainDeal(2)],
      notes: { '1': [{ text: 'заказали курьера, едет сегодня' }], '2': [{ text: 'UQ058702081KZ' }] },
    });
    const world = createWorld();
    const warnings: unknown[] = [];
    const logger = { ...createSilentLogger(), warn: (...args: unknown[]) => void warnings.push(args) };
    const sync = new SyncShipmentsFromCrm({
      crm: adapter,
      shipments: world.shipments,
      syncState: world.syncState,
      tx: world.tx,
      logger: logger as never,
      filter: { deliveryValue: '', trackPattern: DEFAULT_TRACK_CODE_PATTERN },
    });

    const result = await sync.execute();

    expect(result).toMatchObject({ seen: 2, created: 1, skipped: 1 });
    expect(await world.shipments.findByCrmOrderId('1')).toBeNull();
    expect(await world.shipments.findByCrmOrderId('2')).not.toBeNull();
    expect(warnings).toHaveLength(0);
    expect(urls.some((u) => u.includes('change_stage'))).toBe(false);
  });
});

describe('NcrmAdapter + SyncShipmentsFromCrm', () => {
  it('turns NCRM deals into shipments: Kazpost deals with a track in, courier and track-less deals out', async () => {
    const { adapter } = setup([
      {
        body: [
          deal(1),
          deal(2, { field_values: [{ field: TRACK_FIELD, value: 'RR000000002KZ' }, { field: DELIVERY_FIELD, value: 'Курьер' }] }),
          deal(3, { field_values: [{ field: DELIVERY_FIELD, value: 'Казпочта' }] }),
        ],
      },
    ]);
    const world = createWorld();
    const sync = new SyncShipmentsFromCrm({
      crm: adapter,
      shipments: world.shipments,
      syncState: world.syncState,
      tx: world.tx,
      logger: createSilentLogger(),
      filter: { deliveryValue: 'Казпочта', trackPattern: DEFAULT_TRACK_CODE_PATTERN },
    });

    const result = await sync.execute();

    expect(result).toMatchObject({ seen: 3, created: 1, skipped: 2 });
    expect(await world.shipments.findByCrmOrderId('1')).toMatchObject({ trackCode: 'RR123456789KZ', customerName: 'Иванов И.' });
    expect(await world.syncState.get(CRM_CURSOR_KEY)).toBe(new Date('2026-10-31T10:00:00.123456').toISOString());
  });
});
