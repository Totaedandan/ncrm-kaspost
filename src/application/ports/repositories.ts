import type { OutboxEntry } from '../../domain/notification';
import type { NewShipment, Shipment } from '../../domain/shipment';
import type { TrackingEvent } from '../../domain/tracking-event';
import type { TrackingStatus } from '../../domain/tracking-status';

export interface ShipmentRepository {
  findById(id: string): Promise<Shipment | null>;
  findByCrmOrderId(crmOrderId: string): Promise<Shipment | null>;
  findByTrackCode(trackCode: string): Promise<Shipment | null>;
  create(shipment: NewShipment): Promise<Shipment>;
  /** Persists every mutable field of an existing shipment. */
  save(shipment: Shipment): Promise<void>;
  /** Every shipment whose status is not terminal, least recently checked first (never checked = first). */
  findActiveForPolling(limit: number): Promise<Shipment[]>;
  /** crmSyncStatus = PENDING, or FAILED with fewer than `maxAttempts` attempts. */
  findPendingCrmSync(maxAttempts: number, limit: number): Promise<Shipment[]>;
  /** Marks SYNCED only if the status is still `expectedStatus`; returns whether it was applied. */
  markCrmSynced(id: string, expectedStatus: TrackingStatus): Promise<boolean>;
  /** Increments attempts and marks FAILED, only if the status is still `expectedStatus`. */
  markCrmFailed(id: string, expectedStatus: TrackingStatus): Promise<number | null>;
  /** Non-terminal shipments that have not been alerted as stuck yet. */
  findActiveWithoutStuckAlert(): Promise<Shipment[]>;
  findActive(): Promise<Shipment[]>;
  /** Shipments whose current status is one of `statuses` and which changed to it at or after `since`. */
  findByStatusChangedSince(statuses: readonly TrackingStatus[], since: Date): Promise<Shipment[]>;
}

export interface TrackingEventRepository {
  /** Inserts events, silently skipping duplicates; returns the events that were actually new. */
  insertNew(shipmentId: string, trackCode: string, events: readonly TrackingEvent[]): Promise<TrackingEvent[]>;
  listForShipment(shipmentId: string, limit: number): Promise<TrackingEvent[]>;
  deleteForShipment(shipmentId: string): Promise<void>;
}

export interface OutboxMessage {
  id: string;
  entry: OutboxEntry;
  attempts: number;
}

export interface OutboxRepository {
  /** Returns false when an entry with the same dedupKey already exists. */
  enqueue(entry: OutboxEntry): Promise<boolean>;
  /** PENDING entries whose nextAttemptAt <= now, oldest first. */
  findDispatchable(now: Date, limit: number): Promise<OutboxMessage[]>;
  markSent(id: string, now: Date): Promise<void>;
  /** Records a failed attempt. `giveUp` flips the entry to FAILED for good. */
  markAttemptFailed(id: string, error: string, nextAttemptAt: Date, giveUp: boolean): Promise<void>;
  /** Delays an entry without consuming an attempt (rate limiting). */
  postpone(id: string, nextAttemptAt: Date): Promise<void>;
}

export interface SyncStateRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface TxRepositories {
  shipments: ShipmentRepository;
  events: TrackingEventRepository;
  outbox: OutboxRepository;
}

/** Runs `work` atomically: either all repository writes inside happen, or none. */
export interface TransactionRunner {
  run<T>(work: (repos: TxRepositories) => Promise<T>): Promise<T>;
}

export interface HealthProbe {
  /** Rejects when the database is unreachable. */
  ping(): Promise<void>;
}

export interface LockHandle {
  release(): Promise<void>;
}

/** Cross-instance mutual exclusion. */
export interface JobLockPort {
  /** Returns null when someone else holds the lock. */
  tryAcquire(name: string): Promise<LockHandle | null>;
}
