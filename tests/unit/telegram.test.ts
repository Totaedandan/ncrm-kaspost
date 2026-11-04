import { GrammyError, type Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { CheckHealth } from '../../src/application/check-health';
import { BuildDailyReport } from '../../src/application/use-cases/build-daily-report';
import { DetectStuckShipments } from '../../src/application/use-cases/detect-stuck-shipments';
import { newShipment } from '../../src/domain/shipment';
import { DEFAULT_TRACK_CODE_PATTERN } from '../../src/domain/track-code';
import { commandMenu, createBot } from '../../src/infrastructure/telegram/bot';
import { isFatalTelegramError, startPolling } from '../../src/infrastructure/telegram/polling';
import { createSilentLogger } from '../../src/shared/logger';
import { FakeProbe, createWorld, type World } from '../helpers/fakes';

const ADMIN = 1;
const STRANGER = 2;

const BOT_INFO = {
  id: 999,
  is_bot: true,
  first_name: 'Kazpost',
  username: 'kazpost_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

function message(text: string, userId: number, chatId = 100): Update {
  const command = /^\/\w+/.exec(text)?.[0] ?? '';
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private', first_name: 'U', title: 'Chat' } as never,
      from: { id: userId, is_bot: false, first_name: 'U' },
      text,
      entities: command === '' ? [] : [{ type: 'bot_command', offset: 0, length: command.length }],
    },
  };
}

describe('Telegram bot commands', () => {
  let world: World;
  let calls: ApiCall[];
  let bot: Bot;
  let buildReport: BuildDailyReport;

  /** Same path as the polling loop and the webhook: a handler error goes to `bot.catch`. */
  const deliver = async (update: Update): Promise<void> => {
    try {
      await bot.handleUpdate(update);
    } catch (error) {
      await bot.errorHandler(error as never);
    }
  };

  const replies = (): string[] => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload['text']));

  beforeEach(() => {
    world = createWorld();
    calls = [];
    const detectStuck = new DetectStuckShipments({
      shipments: world.shipments,
      tx: world.tx,
      clock: world.clock,
      config: { stuckInOfficeDays: 5, noUpdatesDays: 10 },
    });
    buildReport = new BuildDailyReport({
      shipments: world.shipments,
      outbox: world.outbox,
      detectStuck,
      clock: world.clock,
    });
    bot = createBot({
      token: '123:TEST',
      adminIds: [ADMIN],
      timeZone: 'Asia/Almaty',
      trackPattern: DEFAULT_TRACK_CODE_PATTERN,
      logger: createSilentLogger(),
      shipments: world.shipments,
      events: world.events,
      buildReport,
      detectStuck,
      checkHealth: new CheckHealth({ probe: new FakeProbe(), syncState: world.syncState, clock: world.clock, startedAt: world.clock.now() }),
      botInfo: BOT_INFO,
    });
    bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: { message_id: 1 } } as never;
    });
  });

  it('/id answers everybody with the user id and the chat id', async () => {
    await deliver(message('/id', STRANGER, -5001));

    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toContain(`<code>${STRANGER}</code>`);
    expect(replies()[0]).toContain('<code>-5001</code>');
  });

  it('/start and /help: admins get the command list, strangers get a polite refusal with their id', async () => {
    await deliver(message('/start', ADMIN));
    await deliver(message('/help', STRANGER));

    expect(replies()[0]).toContain('/track RR123456789KZ');
    expect(replies()[0]).toContain('/health');
    expect(replies()[1]).toContain('закрытый');
    expect(replies()[1]).toContain(`<code>${STRANGER}</code>`);
  });

  it('ignores admin commands from strangers without a single API call', async () => {
    for (const command of ['/report', '/stuck', '/health', '/track RR123456789KZ']) {
      await deliver(message(command, STRANGER));
    }
    expect(calls).toHaveLength(0);
  });

  it('/track shows the shipment, rejects a malformed code and an unknown one', async () => {
    await world.shipments.create(newShipment({ crmOrderId: '1042', trackCode: 'RR123456789KZ', customerName: 'Иванов И.' }));

    await deliver(message('/track RR123456789KZ', ADMIN));
    await deliver(message('/track nonsense', ADMIN));
    await deliver(message('/track AA000000000KZ', ADMIN));

    expect(replies()[0]).toContain('RR123456789KZ');
    expect(replies()[0]).toContain('#1042 — Иванов И.');
    expect(replies()[1]).toContain('Использование');
    expect(replies()[2]).toContain('не отслеживается');
  });

  it('/stuck and /health answer admins', async () => {
    await deliver(message('/stuck', ADMIN));
    await deliver(message('/health', ADMIN));

    expect(replies()[0]).toContain('Зависших посылок нет');
    expect(replies()[1]).toContain('Всё в порядке');
  });

  it('replies with HTML parse mode and no link previews', async () => {
    await deliver(message('/report', ADMIN));
    expect(calls[0]?.payload).toMatchObject({ parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });

  it('survives a failing handler: the user gets a short error, the bot keeps working', async () => {
    buildReport.build = async () => Promise.reject(new Error('db down'));

    await deliver(message('/report', ADMIN));
    await deliver(message('/stuck', ADMIN));

    expect(replies()[0]).toContain('Не получилось');
    expect(replies()[1]).toContain('Зависших посылок нет');
  });

  it('publishes a command menu with every admin command and /help', () => {
    const names = commandMenu().map((item) => item.command);
    expect(names).toEqual(expect.arrayContaining(['track', 'report', 'stuck', 'health', 'id', 'help']));
    for (const item of commandMenu()) {
      expect(item.command).toMatch(/^[a-z_]{1,32}$/);
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.description.length).toBeLessThanOrEqual(256);
    }
  });
});

describe('startPolling', () => {
  const logger = createSilentLogger();
  const grammyError = (code: number) => new GrammyError('x', { ok: false, error_code: code, description: 'x' }, 'getMe', {});

  /** A bot whose `start` follows a script: each entry is an error to throw, or 'run' to stay up until stopped. */
  function scriptedBot(script: Array<Error | 'run'>) {
    let running = false;
    let release: () => void = () => undefined;
    const state = { starts: 0, stops: 0 };
    const bot = {
      start: async (options: { onStart?: (me: { username: string }) => void }) => {
        const step = script[state.starts] ?? 'run';
        state.starts += 1;
        if (step !== 'run') throw step;
        running = true;
        options.onStart?.({ username: 'b' });
        await new Promise<void>((resolve) => (release = resolve));
        running = false;
      },
      stop: async () => {
        state.stops += 1;
        release();
      },
      isRunning: () => running,
    };
    return { bot: bot as unknown as Bot, state };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('classifies bad token and a competing instance as fatal, anything else as retryable', () => {
    expect(isFatalTelegramError(grammyError(401))).toBe(true);
    expect(isFatalTelegramError(grammyError(409))).toBe(true);
    expect(isFatalTelegramError(grammyError(500))).toBe(false);
    expect(isFatalTelegramError(new Error('network'))).toBe(false);
  });

  it('retries a failed start, then keeps polling until stopped', async () => {
    const { bot, state } = scriptedBot([new Error('Telegram unreachable'), 'run']);
    const fatal: unknown[] = [];

    const handle = startPolling(bot, { logger, onFatal: (e) => fatal.push(e), retryDelayMs: 1 });
    await settle();
    await handle.stop();

    expect(state.starts).toBe(2);
    expect(state.stops).toBe(1);
    expect(fatal).toHaveLength(0);
  });

  it('reports a fatal error once and does not retry it', async () => {
    const { bot, state } = scriptedBot([grammyError(401)]);
    const fatal: unknown[] = [];

    startPolling(bot, { logger, onFatal: (e) => fatal.push(e), retryDelayMs: 1 });
    await settle();

    expect(fatal).toHaveLength(1);
    expect(state.starts).toBe(1);
  });

  it('stop before the first start finishes does not call bot.stop on an idle bot', async () => {
    const { bot, state } = scriptedBot(['run']);
    const handle = startPolling(bot, { logger, onFatal: () => undefined, retryDelayMs: 1 });
    await handle.stop();
    await settle();
    expect(state.stops).toBeLessThanOrEqual(1);
  });
});
