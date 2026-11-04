import { pickLatestEvent, type TrackingEvent } from './tracking-event';
import { isTerminal, type TrackingStatus } from './tracking-status';

export type CrmSyncStatus = 'PENDING' | 'SYNCED' | 'FAILED';

export interface Shipment {
  readonly id: string;
  readonly crmOrderId: string;
  readonly trackCode: string;
  readonly customerName: string | null;
  readonly status: TrackingStatus;
  readonly rawStatus: string | null;
  readonly lastLocation: string | null;
  readonly statusChangedAt: Date | null;
  readonly lastEventAt: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly pollErrorCount: number;
  readonly deliveredAt: Date | null;
  readonly crmSyncStatus: CrmSyncStatus;
  readonly crmSyncAttempts: number;
  readonly stuckAlertSentAt: Date | null;
  readonly createdAt: Date;
}

export type NewShipment = Omit<Shipment, 'id' | 'createdAt'>;

export interface NewShipmentInput {
  crmOrderId: string;
  trackCode: string;
  customerName: string | null;
}

export function newShipment(input: NewShipmentInput): NewShipment {
  return {
    crmOrderId: input.crmOrderId,
    trackCode: input.trackCode,
    customerName: input.customerName,
    ...freshTrackingState(),
  };
}

/** The CRM order got a different track code: forget everything learned about the old parcel. */
export function resetForNewTrack(shipment: Shipment, trackCode: string): Shipment {
  return { ...shipment, trackCode, ...freshTrackingState() };
}

export interface ObservationResult {
  shipment: Shipment;
  /** True only when the status actually moved; this is what triggers CRM push and notification. */
  statusChanged: boolean;
  previousStatus: TrackingStatus;
}

/**
 * Applies a successful tracking response. Idempotent: feeding the same events again
 * yields `statusChanged === false`. Terminal shipments never change.
 */
export function applyObservation(
  shipment: Shipment,
  events: readonly TrackingEvent[],
  now: Date,
): ObservationResult {
  if (isTerminal(shipment.status)) {
    return { shipment, statusChanged: false, previousStatus: shipment.status };
  }

  const latest = pickLatestEvent(events);
  const returned = hasReturnStarted(events);
  const status: TrackingStatus = returned ? 'RETURNED' : (latest?.status ?? shipment.status);
  const lastEventAt = latest?.occurredAt ?? shipment.lastEventAt;

  const observed: Shipment = {
    ...shipment,
    status,
    rawStatus: latest?.rawStatus ?? shipment.rawStatus,
    lastLocation: latest !== null ? latest.location : shipment.lastLocation,
    lastEventAt,
    lastCheckedAt: now,
    pollErrorCount: 0,
  };

  if (latest === null || status === shipment.status) {
    return { shipment: observed, statusChanged: false, previousStatus: shipment.status };
  }

  return {
    shipment: {
      ...observed,
      // A return is dated by the moment we noticed it: it may have started days ago, but it is news today.
      statusChangedAt: returned ? now : latest.occurredAt,
      deliveredAt: status === 'DELIVERED' ? latest.occurredAt : shipment.deliveredAt,
      crmSyncStatus: 'PENDING',
      crmSyncAttempts: 0,
    },
    statusChanged: true,
    previousStatus: shipment.status,
  };
}

/**
 * Once a parcel has started going back to the sender, it stays "returned": a later "handed over"
 * event is the sender collecting his own parcel, not a delivery to the customer.
 * (Cancelled returns are already removed from the events by the decoder.)
 */
function hasReturnStarted(events: readonly TrackingEvent[]): boolean {
  return events.some((event) => event.status === 'RETURNING' || event.status === 'RETURNED');
}

/** A tracking request failed (network/5xx/schema): count it, keep everything else; the next scheduled run retries. */
export function applyPollFailure(shipment: Shipment, now: Date): Shipment {
  return {
    ...shipment,
    pollErrorCount: shipment.pollErrorCount + 1,
    lastCheckedAt: now,
  };
}

function freshTrackingState(): Omit<NewShipment, 'crmOrderId' | 'trackCode' | 'customerName'> {
  return {
    status: 'REGISTERED',
    rawStatus: null,
    lastLocation: null,
    statusChangedAt: null,
    lastEventAt: null,
    lastCheckedAt: null,
    pollErrorCount: 0,
    deliveredAt: null,
    crmSyncStatus: 'SYNCED',
    crmSyncAttempts: 0,
    stuckAlertSentAt: null,
  };
}
