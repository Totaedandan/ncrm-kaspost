import { createHash } from 'node:crypto';
import type { TrackingStatus } from './tracking-status';

/** One entry of a parcel's history, already mapped to the domain status. */
export interface TrackingEvent {
  status: TrackingStatus;
  rawStatus: string;
  location: string | null;
  occurredAt: Date;
  rawPayload: unknown;
}

export function computeDedupHash(trackCode: string, event: TrackingEvent): string {
  return createHash('sha256')
    .update(
      [trackCode, event.rawStatus, event.occurredAt.toISOString(), event.location ?? ''].join('\u0000'),
    )
    .digest('hex');
}

/** The newest event wins; on equal timestamps the later one in the list wins. */
export function pickLatestEvent(events: readonly TrackingEvent[]): TrackingEvent | null {
  let latest: TrackingEvent | null = null;
  for (const event of events) {
    if (latest === null || event.occurredAt.getTime() >= latest.occurredAt.getTime()) {
      latest = event;
    }
  }
  return latest;
}
