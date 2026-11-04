import { ExternalSchemaError } from '../../domain/errors';
import type { TrackingEvent } from '../../domain/tracking-event';
import { mapKazpostCode, undoTarget } from './kazpost-status.mapper';
import { parseKazpostDateTime, type KazpostResponse } from './kazpost.schemas';

const SERVICE = 'kazpost';

interface FlatActivity {
  code: string;
  occurredAt: Date;
  location: string | null;
  payload: unknown;
}

/**
 * Decodes the day-grouped, newest-first Kazpost history into a chronological list of domain events:
 * - one event per status code (an activity may carry several);
 * - hidden (internal) codes are dropped;
 * - *_UNDO codes retract the latest earlier event of the code they cancel;
 * - codes missing from the official dictionary become UNKNOWN so the use case can alert a developer.
 */
export function decodeKazpostEvents(events: NonNullable<KazpostResponse['events']>, sample: string): TrackingEvent[] {
  const flat = flatten(events, sample);
  const decoded: Array<{ code: string; event: TrackingEvent }> = [];

  for (const activity of flat) {
    const target = undoTarget(activity.code);
    if (target !== null) {
      retractLatest(decoded, target);
      continue;
    }
    const mapping = mapKazpostCode(activity.code);
    if (mapping.kind === 'hidden') continue;

    decoded.push({
      code: activity.code,
      event: {
        status: mapping.kind === 'visible' ? mapping.status : 'UNKNOWN',
        rawStatus: mapping.kind === 'visible' ? `${activity.code}: ${mapping.label}` : activity.code,
        location: activity.location,
        occurredAt: activity.occurredAt,
        rawPayload: activity.payload,
      },
    });
  }
  return decoded.map((d) => d.event);
}

function retractLatest(decoded: Array<{ code: string }>, code: string): void {
  for (let i = decoded.length - 1; i >= 0; i -= 1) {
    if (decoded[i]?.code === code) {
      decoded.splice(i, 1);
      return;
    }
  }
}

/** Oldest first. The API lists newest first, so equal timestamps keep their reversed API order. */
function flatten(days: NonNullable<KazpostResponse['events']>, sample: string): FlatActivity[] {
  const apiOrder: FlatActivity[] = [];
  for (const day of days) {
    for (const activity of day.activity) {
      const occurredAt = parseKazpostDateTime(day.date, activity.time);
      if (occurredAt === null) {
        throw new ExternalSchemaError(SERVICE, `unparsable event time "${day.date} ${activity.time}"`, sample);
      }
      const codes = typeof activity.status === 'string' ? [activity.status] : activity.status;
      for (const code of codes) {
        apiOrder.push({ code, occurredAt, location: locationOf(activity), payload: activity });
      }
    }
  }
  return apiOrder
    .reverse()
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.occurredAt.getTime() - b.item.occurredAt.getTime() || a.index - b.index)
    .map(({ item }) => item);
}

function locationOf(activity: { name?: string | number | null; zip?: string | number | null }): string | null {
  const parts = [activity.name, activity.zip]
    .map((part) => (part === null || part === undefined ? '' : String(part).trim()))
    .filter((part) => part !== '');
  return parts.length > 0 ? parts.join(', ') : null;
}
