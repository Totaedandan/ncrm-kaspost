import type { HealthReport } from '../../application/check-health';
import type {
  DailyReportPayload,
  DevAlertPayload,
  Notification,
  ShipmentNotificationPayload,
  ShipmentRef,
  StuckNotificationPayload,
} from '../../domain/notification';
import type { Shipment } from '../../domain/shipment';
import type { TrackingEvent } from '../../domain/tracking-event';
import type { TrackingStatus } from '../../domain/tracking-status';

export const TELEGRAM_MESSAGE_LIMIT = 4096;
const LIST_LIMIT = 15;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const STATUS_TITLES: Record<TrackingStatus, string> = {
  REGISTERED: '📦 Принято к отправке',
  IN_TRANSIT: '🚚 В пути',
  ARRIVED_AT_OFFICE: '📬 Прибыло в отделение',
  DELIVERED: '✅ Вручено',
  RETURNING: '↩️ Возвращается отправителю',
  RETURNED: '↩️ Возвращено отправителю',
  UNKNOWN: '❓ Неизвестный статус',
};

export function formatDateTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}

export function formatLocalDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
}

function orderLine(ref: ShipmentRef): string {
  const customer = ref.customerName ? ` — ${escapeHtml(ref.customerName)}` : '';
  return `#${escapeHtml(ref.crmOrderId)}${customer}`;
}

function shipmentMessage(payload: ShipmentNotificationPayload, timeZone: string): string {
  const lines = [
    `<b>${STATUS_TITLES[payload.status]}</b>`,
    `Трек: <code>${escapeHtml(payload.trackCode)}</code>`,
    `Заказ: ${orderLine(payload)}`,
  ];
  if (payload.location) lines.push(`Отделение: ${escapeHtml(payload.location)}`);
  if (payload.status === 'UNKNOWN' && payload.rawStatus) lines.push(`Статус: ${escapeHtml(payload.rawStatus)}`);
  lines.push(formatDateTime(new Date(payload.occurredAt), timeZone));
  return lines.join('\n');
}

function stuckMessage(payload: StuckNotificationPayload): string {
  const headline =
    payload.reason === 'IN_OFFICE'
      ? `⏰ <b>Посылка ${payload.days} дн. в отделении</b>\nСкоро уйдёт в возврат, позвоните клиенту.`
      : `⚠️ <b>Нет новых событий ${payload.days} дн.</b>\nПосылка могла зависнуть.`;
  const lines = [
    headline,
    `Трек: <code>${escapeHtml(payload.trackCode)}</code>`,
    `Заказ: ${orderLine(payload)}`,
  ];
  if (payload.location) lines.push(`Отделение: ${escapeHtml(payload.location)}`);
  return lines.join('\n');
}

function refList(title: string, refs: readonly ShipmentRef[], withDetails: boolean): string[] {
  if (refs.length === 0) return [`${title}: 0`];
  const shown = refs.slice(0, LIST_LIMIT).map((ref) =>
    withDetails ? `• <code>${escapeHtml(ref.trackCode)}</code> ${orderLine(ref)}` : '',
  );
  const lines = withDetails ? [`${title}: ${refs.length}`, ...shown] : [`${title}: ${refs.length}`];
  if (withDetails && refs.length > LIST_LIMIT) lines.push(`… и ещё ${refs.length - LIST_LIMIT}`);
  return lines;
}

export function renderDailyReport(payload: DailyReportPayload, timeZone: string): string {
  const lines = [
    `📊 <b>Отчёт Казпочты</b> — ${formatDateTime(new Date(payload.generatedAt), timeZone)}`,
    ...(payload.checked === undefined ? [] : [`🔎 Проверено треков: ${payload.checked}`]),
    '',
    ...refList('✅ Вручено за сутки', payload.delivered, true),
    '',
    ...refList('📬 В отделении', payload.atOffice, false),
    ...refList('⚠️ Зависшие', payload.stuck, true),
    '',
    ...refList('↩️ Возвраты → «Клиент не забрал, отказ»', payload.returns, true),
  ];
  return lines.join('\n');
}

function devAlertMessage(payload: DevAlertPayload): string {
  return `🛠 <b>${escapeHtml(payload.title)}</b>\n<pre>${escapeHtml(payload.details)}</pre>`;
}

export function renderNotification(notification: Notification, timeZone: string): string {
  switch (notification.type) {
    case 'STATUS_CHANGED':
    case 'DELIVERED':
      return clamp(shipmentMessage(notification.payload, timeZone));
    case 'STUCK':
      return clamp(stuckMessage(notification.payload));
    case 'DAILY_REPORT':
      return clamp(renderDailyReport(notification.payload, timeZone));
    case 'DEV_ALERT':
      return clamp(devAlertMessage(notification.payload));
  }
}

export function renderTrackInfo(
  shipment: Shipment,
  events: readonly TrackingEvent[],
  timeZone: string,
): string {
  const lines = [
    `<b>${STATUS_TITLES[shipment.status]}</b>`,
    `Трек: <code>${escapeHtml(shipment.trackCode)}</code>`,
    `Заказ: #${escapeHtml(shipment.crmOrderId)}${shipment.customerName ? ` — ${escapeHtml(shipment.customerName)}` : ''}`,
    '',
    '<b>История:</b>',
  ];
  if (events.length === 0) lines.push('Событий пока нет.');
  for (const event of events) {
    const place = event.location ? ` (${escapeHtml(event.location)})` : '';
    lines.push(`${formatDateTime(event.occurredAt, timeZone)} — ${escapeHtml(event.rawStatus)}${place}`);
  }
  return clamp(lines.join('\n'));
}

export function renderStuckList(
  items: ReadonlyArray<{ ref: ShipmentRef; reason: 'IN_OFFICE' | 'NO_UPDATES'; days: number }>,
): string {
  if (items.length === 0) return 'Зависших посылок нет 👍';
  const lines = items.slice(0, LIST_LIMIT * 2).map((item) => {
    const why = item.reason === 'IN_OFFICE' ? 'в отделении' : 'без новостей';
    return `• <code>${escapeHtml(item.ref.trackCode)}</code> ${orderLine(item.ref)} — ${why} ${item.days} дн.`;
  });
  return clamp(['<b>Зависшие посылки:</b>', ...lines].join('\n'));
}

export function renderHealth(report: HealthReport, timeZone: string): string {
  const lines = [report.ok ? '🟢 <b>Всё в порядке</b>' : '🔴 <b>Есть проблемы</b>'];
  for (const problem of report.problems) lines.push(`• ${escapeHtml(problem)}`);
  lines.push('', '<b>Последние успешные запуски:</b>');
  for (const [job, at] of Object.entries(report.jobs)) {
    lines.push(`${escapeHtml(job)}: ${at ? formatDateTime(new Date(at), timeZone) : '—'}`);
  }
  return clamp(lines.join('\n'));
}

export function renderIds(userId: number | undefined, chatId: number): string {
  return [
    `Ваш Telegram ID: <code>${userId ?? '—'}</code>`,
    `ID этого чата: <code>${chatId}</code>`,
    '',
    'Первый — для <code>TELEGRAM_ADMIN_IDS</code>, второй — для <code>TELEGRAM_REPORT_CHAT_IDS</code> или <code>TELEGRAM_DEV_CHAT_ID</code>.',
  ].join('\n');
}

export const HELP_COMMANDS: ReadonlyArray<{ command: string; usage: string; description: string }> = [
  { command: 'track', usage: '/track RR123456789KZ', description: 'статус и история посылки' },
  { command: 'report', usage: '/report', description: 'отчёт прямо сейчас' },
  { command: 'stuck', usage: '/stuck', description: 'зависшие посылки' },
  { command: 'health', usage: '/health', description: 'состояние сервиса и время последних запусков' },
  { command: 'id', usage: '/id', description: 'ваш Telegram ID и ID чата' },
];

export function renderHelp(): string {
  const lines = HELP_COMMANDS.map((item) => `${item.usage} — ${item.description}`);
  return ['<b>Команды:</b>', ...lines].join('\n');
}

export function renderNotAdmin(userId: number | undefined): string {
  return [
    'Этот бот закрытый: команды доступны только администраторам.',
    `Ваш Telegram ID: <code>${userId ?? '—'}</code> — передайте его администратору сервиса.`,
  ].join('\n');
}

/** Keeps a message under Telegram's limit; cuts at a line boundary so HTML tags stay balanced. */
function clamp(text: string): string {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) return text;
  const cut = text.slice(0, TELEGRAM_MESSAGE_LIMIT - 20);
  const lastBreak = cut.lastIndexOf('\n');
  return `${cut.slice(0, lastBreak > 0 ? lastBreak : cut.length)}\n…`;
}
