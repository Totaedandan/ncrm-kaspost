import type { Shipment } from './shipment';
import { isTerminal } from './tracking-status';

const DAY_MS = 24 * 60 * 60 * 1000;

export type StuckReason = 'IN_OFFICE' | 'NO_UPDATES';

export interface StuckConfig {
  stuckInOfficeDays: number;
  noUpdatesDays: number;
}

export interface StuckVerdict {
  reason: StuckReason;
  days: number;
}

/** Decides whether a parcel is "hanging". Pure: depends only on its arguments. */
export function evaluateStuck(
  shipment: Shipment,
  now: Date,
  config: StuckConfig,
): StuckVerdict | null {
  if (isTerminal(shipment.status)) return null;

  if (shipment.status === 'ARRIVED_AT_OFFICE' && shipment.statusChangedAt !== null) {
    const days = elapsedDays(shipment.statusChangedAt, now);
    if (days >= config.stuckInOfficeDays) return { reason: 'IN_OFFICE', days };
  }

  const lastActivity = shipment.lastEventAt ?? shipment.createdAt;
  const silentDays = elapsedDays(lastActivity, now);
  if (silentDays >= config.noUpdatesDays) return { reason: 'NO_UPDATES', days: silentDays };

  return null;
}

function elapsedDays(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}
