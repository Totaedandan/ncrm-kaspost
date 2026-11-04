import { GrammyError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { loadEnv, EnvError } from '../../src/config/env';
import { ExternalServiceError, RateLimitedError } from '../../src/domain/errors';
import { MockCrmAdapter } from '../../src/infrastructure/crm/mock-crm.adapter';
import { HttpClient } from '../../src/infrastructure/http/http-client';
import { TelegramNotifier, type TelegramSender } from '../../src/infrastructure/telegram/telegram.notifier';
import type { Notification } from '../../src/domain/notification';
import { escapeHtml, renderNotification } from '../../src/infrastructure/telegram/templates';
import { createLimiter, createRateGate } from '../../src/shared/concurrency';
import { createSilentLogger } from '../../src/shared/logger';

const baseEnv = { DATABASE_URL: 'postgresql://x' };

describe('loadEnv', () => {
  it('applies the defaults from the spec', () => {
    const env = loadEnv(baseEnv);
    expect(env).toMatchObject({
      PORT: 3000,
      CRM_DRIVER: 'mock',
      KAZPOST_CONCURRENCY: 3,
      KAZPOST_MIN_INTERVAL_MS: 300,
      POLL_BATCH_SIZE: 1000,
      POLL_CRON: '0 8 * * *',
      HEALTH_POLL_STALE_HOURS: 26,
      STUCK_IN_OFFICE_DAYS: 5,
      NO_UPDATES_DAYS: 10,
      TZ_REPORTS: 'Asia/Almaty',
    });
    expect(env).not.toHaveProperty('DAILY_REPORT_CRON');
    expect(env.TRACK_CODE_REGEX.test('RR123456789KZ')).toBe(true);
  });

  it('parses lists, maps and flags', () => {
    const env = loadEnv({
      ...baseEnv,
      TELEGRAM_REPORT_CHAT_IDS: '-100, -200 ',
      TELEGRAM_ADMIN_IDS: '1,2',
      CRM_STATUS_MAP: '{"DELIVERED":"stage-9"}',
      CRM_ADD_COMMENT: 'true',
    });
    expect(env.TELEGRAM_REPORT_CHAT_IDS).toEqual(['-100', '-200']);
    expect(env.TELEGRAM_ADMIN_IDS).toEqual([1, 2]);
    expect(env.CRM_STATUS_MAP).toEqual({ DELIVERED: 'stage-9' });
    expect(env.CRM_ADD_COMMENT).toBe(true);
  });

  it('fails fast and lists every problem', () => {
    expect(() =>
      loadEnv({ CRM_STATUS_MAP: '{"NOPE":"1"}', TRACK_CODE_REGEX: '(', KAZPOST_CONCURRENCY: '0' } as never),
    ).toThrow(EnvError);
    try {
      loadEnv({ CRM_STATUS_MAP: '{"NOPE":"1"}', TRACK_CODE_REGEX: '(' });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('CRM_STATUS_MAP');
      expect(message).toContain('TRACK_CODE_REGEX');
    }
  });

  it('requires NCRM credentials for the ncrm driver and a bot token in production', () => {
    expect(() => loadEnv({ ...baseEnv, CRM_DRIVER: 'ncrm' })).toThrow(/NCRM_BASE_URL/);
    expect(() => loadEnv({ ...baseEnv, NODE_ENV: 'production' })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('parses RUN_ON_START and rejects unknown job names', () => {
    expect(loadEnv(baseEnv).RUN_ON_START).toEqual([]);
    expect(loadEnv({ ...baseEnv, RUN_ON_START: 'sync-crm, poll-tracking' }).RUN_ON_START).toEqual(['sync-crm', 'poll-tracking']);
    expect(() => loadEnv({ ...baseEnv, RUN_ON_START: 'nope' })).toThrow(/RUN_ON_START/);
  });

  it('polling is the default Telegram mode and needs no public URL or webhook secret', () => {
    const env = loadEnv({ ...baseEnv, TELEGRAM_BOT_TOKEN: 't' });
    expect(env.TELEGRAM_MODE).toBe('polling');
  });

  it('webhook mode requires the secret and the public URL', () => {
    const webhook = { ...baseEnv, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_MODE: 'webhook' };
    expect(() => loadEnv(webhook)).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(() => loadEnv({ ...webhook, TELEGRAM_WEBHOOK_SECRET: 's' })).toThrow(/TELEGRAM_PUBLIC_URL/);
    expect(loadEnv({ ...webhook, TELEGRAM_WEBHOOK_SECRET: 's', TELEGRAM_PUBLIC_URL: 'https://bot.example.com' }).TELEGRAM_MODE).toBe('webhook');
  });

  it('notifies only on statuses that need a reaction unless configured otherwise', () => {
    expect(loadEnv(baseEnv).TELEGRAM_NOTIFY_STATUSES).toEqual(['DELIVERED']);
    expect(loadEnv({ ...baseEnv, TELEGRAM_NOTIFY_STATUSES: 'DELIVERED, IN_TRANSIT' }).TELEGRAM_NOTIFY_STATUSES).toEqual(['DELIVERED', 'IN_TRANSIT']);
    expect(() => loadEnv({ ...baseEnv, TELEGRAM_NOTIFY_STATUSES: 'DELIVERD' })).toThrow(/TELEGRAM_NOTIFY_STATUSES/);
  });
});

describe('HttpClient', () => {
  const noSleep = async () => undefined;

  it('retries 5xx and network errors, then succeeds', async () => {
    const responses = [new Error('ECONNRESET'), new Response('', { status: 503 }), new Response('ok', { status: 200 })];
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      const next = responses[call++];
      if (next instanceof Error) throw next;
      return next!;
    };
    const http = new HttpClient({ service: 's', userAgent: 'ua', fetchImpl, sleepImpl: noSleep });

    expect(await http.get('https://x.test')).toEqual({ status: 200, text: 'ok' });
    expect(call).toBe(3);
  });

  it('gives up after 3 retries with an ExternalServiceError', async () => {
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call += 1;
      return new Response('', { status: 500 });
    };
    const http = new HttpClient({ service: 's', userAgent: 'ua', fetchImpl, sleepImpl: noSleep });

    await expect(http.get('https://x.test')).rejects.toBeInstanceOf(ExternalServiceError);
    expect(call).toBe(4);
  });

  it('does not retry 4xx and sends the User-Agent', async () => {
    let call = 0;
    let headers: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      call += 1;
      headers = init?.headers;
      return new Response('nope', { status: 404 });
    };
    const http = new HttpClient({ service: 's', userAgent: 'my-ua', fetchImpl, sleepImpl: noSleep });

    expect((await http.get('https://x.test')).status).toBe(404);
    expect(call).toBe(1);
    expect(headers).toMatchObject({ 'User-Agent': 'my-ua' });
  });

  it('backs off with growing, jittered delays', async () => {
    const delays: number[] = [];
    const http = new HttpClient({
      service: 's',
      userAgent: 'ua',
      baseDelayMs: 100,
      random: () => 0.5,
      fetchImpl: async () => new Response('', { status: 500 }),
      sleepImpl: async (ms) => void delays.push(ms),
    });

    await expect(http.get('https://x.test')).rejects.toThrow();

    expect(delays).toEqual([75, 150, 300]);
  });
});

describe('concurrency helpers', () => {
  it('limiter never exceeds its limit and returns results', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        limit(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 3));
          active -= 1;
          return n * 2;
        }),
      ),
    );
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });

  it('limiter keeps working after a task throws', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(limit(async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects an invalid concurrency', () => {
    expect(() => createLimiter(0)).toThrow(RangeError);
  });

  it('rate gate spaces calls apart', async () => {
    const gate = createRateGate(30);
    const started = performance.now();
    await Promise.all([gate(), gate(), gate()]);
    expect(performance.now() - started).toBeGreaterThanOrEqual(55);
  });
});

describe('Telegram templates', () => {
  it('escapes HTML', () => {
    expect(escapeHtml('<b>&"x"</b>')).toBe('&lt;b&gt;&amp;"x"&lt;/b&gt;');
  });

  it('renders the delivered notification like the spec example', () => {
    const text = renderNotification(
      {
        type: 'DELIVERED',
        payload: {
          trackCode: 'RR123456789KZ',
          crmOrderId: '1042',
          customerName: 'Иванов И.',
          status: 'DELIVERED',
          rawStatus: 'Вручено',
          location: 'Алматы 050000',
          occurredAt: '2026-11-19T09:32:00Z',
        },
      },
      'Asia/Almaty',
    );
    expect(text).toBe(
      [
        '<b>✅ Вручено</b>',
        'Трек: <code>RR123456789KZ</code>',
        'Заказ: #1042 — Иванов И.',
        'Отделение: Алматы 050000',
        '19.11.2026 14:32',
      ].join('\n'),
    );
  });

  it('escapes user-controlled data and never exceeds the Telegram limit', () => {
    const refs = Array.from({ length: 500 }, (_, i) => ({
      trackCode: `RR${i}KZ`,
      crmOrderId: String(i),
      customerName: '<script>' + 'x'.repeat(100),
    }));
    const text = renderNotification(
      {
        type: 'DAILY_REPORT',
        payload: { generatedAt: '2026-11-19T04:00:00Z', delivered: refs, atOffice: refs, stuck: refs, returns: refs },
      },
      'Asia/Almaty',
    );
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).not.toContain('<script>');
    expect(text).toContain('и ещё');
  });

  it('daily report has no "В пути" section but keeps delivered and at-office', () => {
    const text = renderNotification(
      {
        type: 'DAILY_REPORT',
        payload: { generatedAt: '2026-11-19T04:00:00Z', delivered: [], atOffice: [], stuck: [], returns: [] },
      },
      'Asia/Almaty',
    );
    expect(text).not.toContain('В пути');
    expect(text).not.toContain('Проверено');
    expect(text).toContain('Вручено за сутки');
    expect(text).toContain('В отделении: 0');
  });

  it('post-poll report shows the checked count and the office count without a list', () => {
    const refs = [{ trackCode: 'RR1KZ', crmOrderId: '1', customerName: 'Иванов' }];
    const text = renderNotification(
      {
        type: 'DAILY_REPORT',
        payload: { generatedAt: '2026-11-19T04:00:00Z', checked: 153, delivered: refs, atOffice: refs, stuck: [], returns: [] },
      },
      'Asia/Almaty',
    );
    expect(text).toContain('Проверено треков: 153');
    expect(text).toContain('В отделении: 1');
    expect(text.match(/RR1KZ/g)).toHaveLength(1); // listed under "delivered" only
  });

  it('returns section names the CRM column and lists deal number, track code and client', () => {
    const returned = [{ trackCode: 'RR000000012KZ', crmOrderId: '12', customerName: 'Иванов И.' }];
    const text = renderNotification(
      {
        type: 'DAILY_REPORT',
        payload: { generatedAt: '2026-11-19T04:00:00Z', checked: 10, delivered: [], atOffice: [], stuck: [], returns: returned },
      },
      'Asia/Almaty',
    );
    expect(text).toContain('Возвраты → «Клиент не забрал, отказ»: 1');
    expect(text).toContain('#12');
    expect(text).toContain('<code>RR000000012KZ</code>');
  });
});

describe('TelegramNotifier', () => {
  const alert: Notification = { type: 'DEV_ALERT', payload: { title: 't', details: 'd' } };
  const report: Notification = { type: 'DAILY_REPORT', payload: { generatedAt: '2026-11-19T04:00:00Z', delivered: [], atOffice: [], stuck: [], returns: [] } };

  function setup(sender: TelegramSender) {
    return new TelegramNotifier({ sender, reportChatIds: ['-1', '-2'], devChatId: '99', timeZone: 'Asia/Almaty', logger: createSilentLogger() });
  }

  it('routes DEV_ALERT to the dev chat and everything else to the report chats', async () => {
    const chats: Array<string | number> = [];
    const notifier = setup({ sendMessage: async (chat) => void chats.push(chat) });

    await notifier.send(alert);
    await notifier.send(report);

    expect(chats).toEqual(['99', '-1', '-2']);
  });

  it('translates Telegram 429 into RateLimitedError with retry_after', async () => {
    const error = new GrammyError('Too Many Requests', { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }, 'sendMessage', {});
    const notifier = setup({ sendMessage: async () => Promise.reject(error) });

    await expect(notifier.send(alert)).rejects.toMatchObject({ retryAfterSeconds: 7 });
    await expect(notifier.send(alert)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('skips a chat that never started the bot (403) and still delivers to the others, once', async () => {
    const forbidden = new GrammyError('Forbidden', { ok: false, error_code: 403, description: 'Forbidden: bot can\'t initiate conversation with a user' }, 'sendMessage', {});
    const delivered: Array<string | number> = [];
    const notifier = setup({
      sendMessage: async (chat) => {
        if (chat === '-1') throw forbidden;
        delivered.push(chat);
      },
    });

    await expect(notifier.send(report)).resolves.toBeUndefined();

    expect(delivered).toEqual(['-2']);
  });

  it('fails the notification when no chat could be reached at all', async () => {
    const forbidden = new GrammyError('Forbidden', { ok: false, error_code: 403, description: 'Forbidden' }, 'sendMessage', {});
    const notifier = setup({ sendMessage: async () => Promise.reject(forbidden) });

    await expect(notifier.send(report)).rejects.toBe(forbidden);
  });

  it('propagates other errors so the outbox retries', async () => {
    const notifier = setup({ sendMessage: async () => Promise.reject(new Error('network')) });
    await expect(notifier.send(alert)).rejects.toThrow('network');
  });

  it('drops (does not fail) when no recipient is configured', async () => {
    let called = false;
    const notifier = new TelegramNotifier({ sender: { sendMessage: async () => void (called = true) }, reportChatIds: [], devChatId: '', timeZone: 'UTC', logger: createSilentLogger() });
    await notifier.send(alert);
    expect(called).toBe(false);
  });
});

describe('CRM adapters', () => {
  it('MockCrmAdapter serves Kazpost and courier orders and records pushes', async () => {
    const crm = new MockCrmAdapter();
    const orders = [];
    for await (const page of crm.listOrdersUpdatedSince(null)) orders.push(...page.orders);

    expect(orders.some((o) => o.deliveryMethod === 'Казпочта' && o.trackCode)).toBe(true);
    expect(orders.some((o) => o.deliveryMethod === 'Курьер' && o.trackCode === null)).toBe(true);

    await crm.updateOrderStatus('1042', 'stage');
    expect(crm.calls).toEqual([{ kind: 'status', orderId: '1042', value: 'stage' }]);
    await expect(crm.updateOrderStatus('nope', 's')).rejects.toThrow();
  });

  it('MockCrmAdapter filters by cursor', async () => {
    const crm = new MockCrmAdapter();
    const orders = [];
    for await (const page of crm.listOrdersUpdatedSince('2027-01-01T00:00:00Z')) orders.push(...page.orders);
    expect(orders).toHaveLength(0);
  });
});
