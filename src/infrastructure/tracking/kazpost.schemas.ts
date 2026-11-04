import { z } from 'zod';

/**
 * Response of GET {base}/{track}/events (Kazpost Open API, "Сервис трекинга по трек-номеру").
 * Validation is deliberately soft: unknown fields are ignored and optional text fields may be
 * missing, null or numeric. Only what the mapping really needs is required.
 */
const text = z.union([z.string(), z.number()]).nullish();

const activitySchema = z.object({
  time: z.string(),
  zip: text,
  city: text,
  name: text,
  status: z.union([z.array(z.string()), z.string()]),
});

const eventDaySchema = z.object({
  date: z.string(),
  activity: z.array(activitySchema),
});

export const kazpostResponseSchema = z.object({
  trackid: z.string().optional(),
  error: z.string().optional(),
  events: z.array(eventDaySchema).optional(),
});

export type KazpostResponse = z.infer<typeof kazpostResponseSchema>;
export type KazpostActivity = z.infer<typeof activitySchema>;

/** Kazakhstan has been on a single UTC+5 timezone since 2024-03-01. */
const LOCAL_OFFSET = '+05:00';
const LOCAL_FORMAT = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** Parses "DD.MM.YYYY" + "HH:mm[:ss]" (local time) into an instant; null when unparsable. */
export function parseKazpostDateTime(date: string, time: string): Date | null {
  const match = LOCAL_FORMAT.exec(`${date.trim()} ${time.trim()}`);
  if (!match) return null;
  const [, dd, mm, yyyy, hh = '00', min = '00', ss = '00'] = match;
  const parsed = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}${LOCAL_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
