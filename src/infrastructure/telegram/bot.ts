import { Bot, type BotError, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { CheckHealth } from '../../application/check-health';
import { errorMessage } from '../../application/dev-alert';
import type { TrackingEventRepository, ShipmentRepository } from '../../application/ports/repositories';
import type { BuildDailyReport } from '../../application/use-cases/build-daily-report';
import type { DetectStuckShipments } from '../../application/use-cases/detect-stuck-shipments';
import { TrackCode } from '../../domain/track-code';
import type { Logger } from '../../shared/logger';
import {
  HELP_COMMANDS,
  renderDailyReport,
  renderHealth,
  renderHelp,
  renderIds,
  renderNotAdmin,
  renderStuckList,
  renderTrackInfo,
} from './templates';

const HISTORY_LIMIT = 10;
const REPLY_OPTIONS = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;
const FAILURE_REPLY = 'Не получилось выполнить команду. Подробности в логах сервиса.';

export interface BotDeps {
  token: string;
  adminIds: readonly number[];
  timeZone: string;
  trackPattern: RegExp;
  logger: Logger;
  shipments: ShipmentRepository;
  events: TrackingEventRepository;
  buildReport: BuildDailyReport;
  detectStuck: DetectStuckShipments;
  checkHealth: CheckHealth;
  /** Skips the `getMe` call on init; used by tests. */
  botInfo?: UserFromGetMe;
}

/** The menu Telegram shows when a user types "/". */
export function commandMenu(): Array<{ command: string; description: string }> {
  const description = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
  return [
    ...HELP_COMMANDS.map((item) => ({ command: item.command, description: description(item.description) })),
    { command: 'help', description: 'Список команд' },
  ];
}

/**
 * `/id`, `/start` and `/help` answer everyone (a newcomer needs to learn their id to be added as an admin);
 * every other command is admin-only and silently ignored for anyone else.
 * Each handler only fetches data and hands it to a template.
 */
export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : {});
  const isAdmin = (ctx: Context): boolean => ctx.from !== undefined && deps.adminIds.includes(ctx.from.id);

  bot.command('id', (ctx) => ctx.reply(renderIds(ctx.from?.id, ctx.chat.id), REPLY_OPTIONS));
  bot.command(['start', 'help'], (ctx) =>
    ctx.reply(isAdmin(ctx) ? renderHelp() : renderNotAdmin(ctx.from?.id), REPLY_OPTIONS),
  );

  bot.use(async (ctx, next) => {
    if (isAdmin(ctx)) await next();
  });

  bot.command('track', async (ctx) => {
    const code = TrackCode.tryParse(ctx.match, deps.trackPattern);
    if (code === null) return void (await ctx.reply('Использование: /track RR123456789KZ'));

    const shipment = await deps.shipments.findByTrackCode(code.value);
    if (shipment === null) return void (await ctx.reply('Такой трек не отслеживается.'));

    const events = await deps.events.listForShipment(shipment.id, HISTORY_LIMIT);
    await ctx.reply(renderTrackInfo(shipment, events, deps.timeZone), REPLY_OPTIONS);
  });

  bot.command('report', async (ctx) => {
    const report = await deps.buildReport.build();
    await ctx.reply(renderDailyReport(report, deps.timeZone), REPLY_OPTIONS);
  });

  bot.command('stuck', async (ctx) => {
    const stuck = await deps.detectStuck.listStuck();
    const items = stuck.map(({ shipment, verdict }) => ({
      ref: {
        trackCode: shipment.trackCode,
        crmOrderId: shipment.crmOrderId,
        customerName: shipment.customerName,
      },
      reason: verdict.reason,
      days: verdict.days,
    }));
    await ctx.reply(renderStuckList(items), REPLY_OPTIONS);
  });

  bot.command('health', async (ctx) => {
    await ctx.reply(renderHealth(await deps.checkHealth.execute(), deps.timeZone), REPLY_OPTIONS);
  });

  // Without this, one failing handler would stop the whole polling loop.
  bot.catch(async (error: BotError) => {
    deps.logger.error({ err: errorMessage(error.error), updateId: error.ctx.update.update_id }, 'telegram handler failed');
    await error.ctx.reply(FAILURE_REPLY).catch(() => undefined);
  });

  return bot;
}
