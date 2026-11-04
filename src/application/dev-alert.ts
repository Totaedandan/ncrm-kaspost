import type { OutboxEntry } from '../domain/notification';

const MAX_DETAILS_LENGTH = 1500;

export function devAlertEntry(dedupKey: string, title: string, details: string): OutboxEntry {
  return {
    type: 'DEV_ALERT',
    dedupKey,
    payload: { title, details: details.slice(0, MAX_DETAILS_LENGTH) },
  };
}

/** Hour bucket for alerts that may repeat, but not more than once an hour. */
export function hourBucket(now: Date): string {
  return now.toISOString().slice(0, 13);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
