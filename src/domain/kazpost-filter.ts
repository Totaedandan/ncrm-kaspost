import type { CrmOrder } from './order';
import { TrackCode } from './track-code';

export interface KazpostFilterConfig {
  /** Value of the CRM "delivery method" field meaning Kazpost. Empty = field is not used. */
  deliveryValue: string;
  trackPattern: RegExp;
}

export type KazpostDecision =
  | { kind: 'accept'; trackCode: TrackCode }
  | { kind: 'skip'; reason: 'NOT_KAZPOST' | 'NO_TRACK' | 'INVALID_TRACK' };

/**
 * An order is tracked when it is a Kazpost order AND carries a valid track code.
 * If the CRM exposes no delivery method (field not configured or empty on the order),
 * only the track code decides.
 */
export function decideKazpostOrder(order: CrmOrder, config: KazpostFilterConfig): KazpostDecision {
  const expected = config.deliveryValue.trim().toLowerCase();
  const actual = order.deliveryMethod?.trim().toLowerCase() ?? '';
  if (expected !== '' && actual !== '' && actual !== expected) {
    return { kind: 'skip', reason: 'NOT_KAZPOST' };
  }

  const rawTrack = order.trackCode?.trim() ?? '';
  if (rawTrack === '') return { kind: 'skip', reason: 'NO_TRACK' };

  const trackCode = TrackCode.tryParse(rawTrack, config.trackPattern);
  if (trackCode === null) return { kind: 'skip', reason: 'INVALID_TRACK' };

  return { kind: 'accept', trackCode };
}
