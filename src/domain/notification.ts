import type { TrackingStatus } from './tracking-status';

export const NOTIFICATION_TYPES = [
  'STATUS_CHANGED',
  'DELIVERED',
  'STUCK',
  'DAILY_REPORT',
  'DEV_ALERT',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface ShipmentRef {
  trackCode: string;
  crmOrderId: string;
  customerName: string | null;
}

export interface ShipmentNotificationPayload extends ShipmentRef {
  status: TrackingStatus;
  rawStatus: string | null;
  location: string | null;
  /** ISO timestamp of the event that caused the notification. */
  occurredAt: string;
}

export interface StuckNotificationPayload extends ShipmentRef {
  reason: 'IN_OFFICE' | 'NO_UPDATES';
  days: number;
  location: string | null;
}

export interface DailyReportPayload {
  /** ISO timestamp of report generation. */
  generatedAt: string;
  /** How many tracks the poll run that produced this report checked (absent in /report and older reports). */
  checked?: number;
  delivered: ShipmentRef[];
  atOffice: ShipmentRef[];
  stuck: ShipmentRef[];
  returns: ShipmentRef[];
}

export interface DevAlertPayload {
  title: string;
  details: string;
}

export interface NotificationPayloadMap {
  STATUS_CHANGED: ShipmentNotificationPayload;
  DELIVERED: ShipmentNotificationPayload;
  STUCK: StuckNotificationPayload;
  DAILY_REPORT: DailyReportPayload;
  DEV_ALERT: DevAlertPayload;
}

/** A message the business wants delivered. Rendering is the notifier's job. */
export type Notification = {
  [K in NotificationType]: { type: K; payload: NotificationPayloadMap[K] };
}[NotificationType];

/** A notification with the key that makes enqueueing it idempotent. */
export type OutboxEntry = Notification & { dedupKey: string };
