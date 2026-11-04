export const TRACKING_STATUSES = [
  'REGISTERED',
  'IN_TRANSIT',
  'ARRIVED_AT_OFFICE',
  'DELIVERED',
  'RETURNING',
  'RETURNED',
  'UNKNOWN',
] as const;

export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

const TERMINAL: ReadonlySet<TrackingStatus> = new Set(['DELIVERED', 'RETURNED']);

export const TERMINAL_STATUSES: readonly TrackingStatus[] = ['DELIVERED', 'RETURNED'];

export function isTerminal(status: TrackingStatus): boolean {
  return TERMINAL.has(status);
}

export function isTrackingStatus(value: string): value is TrackingStatus {
  return (TRACKING_STATUSES as readonly string[]).includes(value);
}
