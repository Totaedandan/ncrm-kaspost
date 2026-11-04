import type { CrmOrderPage, CrmPort } from '../../src/application/ports/crm.port';
import type { NotifierPort } from '../../src/application/ports/notifier.port';
import type {
  HealthProbe,
  JobLockPort,
  LockHandle,
  OutboxMessage,
  OutboxRepository,
  ShipmentRepository,
  SyncStateRepository,
  TrackingEventRepository,
  TransactionRunner,
  TxRepositories,
} from '../../src/application/ports/repositories';
import type { TrackingPort } from '../../src/application/ports/tracking.port';
import type { Notification, OutboxEntry } from '../../src/domain/notification';
import type { NewShipment, Shipment } from '../../src/domain/shipment';
import { computeDedupHash, type TrackingEvent } from '../../src/domain/tracking-event';
import { TERMINAL_STATUSES, type TrackingStatus } from '../../src/domain/tracking-status';
import type { CrmOrder } from '../../src/domain/order';
import type { Clock } from '../../src/shared/clock';

export class TestClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  set(date: Date): void {
    this.current = date;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

interface OutboxRow {
  id: string;
  entry: OutboxEntry;
  status: 'PENDING' | 'SENT' | 'FAILED';
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
}

interface StoredEvent {
  shipmentId: string;
  hash: string;
  event: TrackingEvent;
}

/** All in-memory tables of the fake persistence layer; snapshot/restore gives transaction rollback. */
export class Store {
  shipments = new Map<string, Shipment>();
  events = new Map<string, StoredEvent>();
  outbox = new Map<string, OutboxRow>();
  syncState = new Map<string, string>();
  sequence = 0;

  snapshot(): Store {
    const copy = new Store();
    copy.shipments = new Map(this.shipments);
    copy.events = new Map(this.events);
    copy.outbox = new Map([...this.outbox].map(([k, v]) => [k, { ...v }]));
    copy.syncState = new Map(this.syncState);
    copy.sequence = this.sequence;
    return copy;
  }

  restore(from: Store): void {
    this.shipments = from.shipments;
    this.events = from.events;
    this.outbox = from.outbox;
    this.syncState = from.syncState;
    this.sequence = from.sequence;
  }

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }
}

export class InMemoryShipments implements ShipmentRepository {
  constructor(private readonly store: Store, private readonly clock: Clock) {}

  async findById(id: string) {
    return this.store.shipments.get(id) ?? null;
  }
  async findByCrmOrderId(crmOrderId: string) {
    return this.all().find((s) => s.crmOrderId === crmOrderId) ?? null;
  }
  async findByTrackCode(trackCode: string) {
    return this.all().find((s) => s.trackCode === trackCode) ?? null;
  }
  async create(data: NewShipment): Promise<Shipment> {
    const shipment: Shipment = { ...data, id: this.store.nextId('sh'), createdAt: this.clock.now() };
    this.store.shipments.set(shipment.id, shipment);
    return shipment;
  }
  async save(shipment: Shipment): Promise<void> {
    if (!this.store.shipments.has(shipment.id)) throw new Error(`unknown shipment ${shipment.id}`);
    this.store.shipments.set(shipment.id, shipment);
  }
  async findActiveForPolling(limit: number) {
    return this.all()
      .filter((s) => !isTerminalStatus(s.status))
      .sort((a, b) => (a.lastCheckedAt?.getTime() ?? -Infinity) - (b.lastCheckedAt?.getTime() ?? -Infinity))
      .slice(0, limit);
  }
  async findPendingCrmSync(maxAttempts: number, limit: number) {
    return this.all()
      .filter(
        (s) => s.crmSyncStatus === 'PENDING' || (s.crmSyncStatus === 'FAILED' && s.crmSyncAttempts < maxAttempts),
      )
      .slice(0, limit);
  }
  async markCrmSynced(id: string, expectedStatus: TrackingStatus) {
    const s = this.store.shipments.get(id);
    if (!s || s.status !== expectedStatus) return false;
    this.store.shipments.set(id, { ...s, crmSyncStatus: 'SYNCED', crmSyncAttempts: 0 });
    return true;
  }
  async markCrmFailed(id: string, expectedStatus: TrackingStatus) {
    const s = this.store.shipments.get(id);
    if (!s || s.status !== expectedStatus) return null;
    const attempts = s.crmSyncAttempts + 1;
    this.store.shipments.set(id, { ...s, crmSyncStatus: 'FAILED', crmSyncAttempts: attempts });
    return attempts;
  }
  async findActiveWithoutStuckAlert() {
    return this.all().filter((s) => s.stuckAlertSentAt === null && !isTerminalStatus(s.status));
  }
  async findActive() {
    return this.all().filter((s) => !isTerminalStatus(s.status));
  }
  async findByStatusChangedSince(statuses: readonly TrackingStatus[], since: Date) {
    return this.all().filter(
      (s) => statuses.includes(s.status) && s.statusChangedAt !== null && s.statusChangedAt >= since,
    );
  }

  private all(): Shipment[] {
    return [...this.store.shipments.values()];
  }
}

function isTerminalStatus(status: TrackingStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export class InMemoryEvents implements TrackingEventRepository {
  constructor(private readonly store: Store) {}

  async insertNew(shipmentId: string, trackCode: string, events: readonly TrackingEvent[]) {
    const fresh: TrackingEvent[] = [];
    for (const event of events) {
      const hash = computeDedupHash(trackCode, event);
      if (this.store.events.has(hash)) continue;
      this.store.events.set(hash, { shipmentId, hash, event });
      fresh.push(event);
    }
    return fresh;
  }
  async listForShipment(shipmentId: string, limit: number) {
    return [...this.store.events.values()]
      .filter((e) => e.shipmentId === shipmentId)
      .map((e) => e.event)
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, limit);
  }
  async deleteForShipment(shipmentId: string) {
    for (const [hash, e] of this.store.events) if (e.shipmentId === shipmentId) this.store.events.delete(hash);
  }
}

export class InMemoryOutbox implements OutboxRepository {
  constructor(private readonly store: Store, private readonly clock: Clock) {}

  async enqueue(entry: OutboxEntry) {
    if ([...this.store.outbox.values()].some((r) => r.entry.dedupKey === entry.dedupKey)) return false;
    const id = this.store.nextId('ob');
    this.store.outbox.set(id, {
      id,
      entry,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: this.clock.now(),
      lastError: null,
    });
    return true;
  }
  async findDispatchable(now: Date, limit: number): Promise<OutboxMessage[]> {
    return [...this.store.outbox.values()]
      .filter((r) => r.status === 'PENDING' && r.nextAttemptAt <= now)
      .slice(0, limit)
      .map((r) => ({ id: r.id, entry: r.entry, attempts: r.attempts }));
  }
  async markSent(id: string) {
    this.row(id).status = 'SENT';
  }
  async markAttemptFailed(id: string, error: string, nextAttemptAt: Date, giveUp: boolean) {
    const row = this.row(id);
    row.attempts += 1;
    row.lastError = error;
    row.nextAttemptAt = nextAttemptAt;
    row.status = giveUp ? 'FAILED' : 'PENDING';
  }
  async postpone(id: string, nextAttemptAt: Date) {
    this.row(id).nextAttemptAt = nextAttemptAt;
  }

  private row(id: string): OutboxRow {
    const row = this.store.outbox.get(id);
    if (!row) throw new Error(`unknown outbox row ${id}`);
    return row;
  }
}

export class InMemorySyncState implements SyncStateRepository {
  constructor(private readonly store: Store) {}
  async get(key: string) {
    return this.store.syncState.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.store.syncState.set(key, value);
  }
}

export class InMemoryTx implements TransactionRunner {
  constructor(private readonly store: Store, private readonly repos: TxRepositories) {}

  async run<T>(work: (repos: TxRepositories) => Promise<T>): Promise<T> {
    const before = this.store.snapshot();
    try {
      return await work(this.repos);
    } catch (error) {
      this.store.restore(before);
      throw error;
    }
  }
}

export interface World {
  clock: TestClock;
  store: Store;
  shipments: InMemoryShipments;
  events: InMemoryEvents;
  outbox: InMemoryOutbox;
  syncState: InMemorySyncState;
  tx: InMemoryTx;
  /** Pending + sent notifications as plain data. */
  outboxEntries(): OutboxEntry[];
  outboxOfType(type: Notification['type']): OutboxEntry[];
}

export const T0 = new Date('2026-11-01T10:00:00Z');

export function createWorld(start: Date = T0): World {
  const clock = new TestClock(start);
  const store = new Store();
  const shipments = new InMemoryShipments(store, clock);
  const events = new InMemoryEvents(store);
  const outbox = new InMemoryOutbox(store, clock);
  const syncState = new InMemorySyncState(store);
  const tx = new InMemoryTx(store, { shipments, events, outbox });
  const entries = (): OutboxEntry[] => [...store.outbox.values()].map((r) => r.entry);
  return {
    clock,
    store,
    shipments,
    events,
    outbox,
    syncState,
    tx,
    outboxEntries: entries,
    outboxOfType: (type) => entries().filter((e) => e.type === type),
  };
}

export class FakeTracking implements TrackingPort {
  readonly requests: string[] = [];
  private readonly responses = new Map<string, TrackingEvent[] | Error>();

  respond(trackCode: string, response: TrackingEvent[] | Error): void {
    this.responses.set(trackCode, response);
  }

  async fetchEvents(trackCode: string): Promise<TrackingEvent[]> {
    this.requests.push(trackCode);
    const response = this.responses.get(trackCode) ?? [];
    if (response instanceof Error) throw response;
    return response;
  }
}

export class FakeNotifier implements NotifierPort {
  readonly sent: Notification[] = [];
  failWith: Error | null = null;

  async send(notification: Notification): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push(notification);
  }
}

export class FakeCrm implements CrmPort {
  readonly statusCalls: Array<{ orderId: string; statusId: string }> = [];
  readonly comments: Array<{ orderId: string; text: string }> = [];
  failStatus: Error | null = null;
  failComment: Error | null = null;
  failRead: Error | null = null;

  constructor(public orders: CrmOrder[] = []) {}

  async *listOrdersUpdatedSince(cursor: string | null): AsyncIterable<CrmOrderPage> {
    const threshold = cursor === null ? null : new Date(cursor);
    yield { orders: this.orders.filter((o) => threshold === null || o.updatedAt >= threshold) };
  }
  async getOrderStatus(orderId: string): Promise<string | null> {
    if (this.failRead) throw this.failRead;
    return this.orders.find((o) => o.id === orderId)?.status ?? null;
  }
  async updateOrderStatus(orderId: string, statusId: string) {
    if (this.failStatus) throw this.failStatus;
    this.statusCalls.push({ orderId, statusId });
  }
  async addOrderComment(orderId: string, text: string) {
    if (this.failComment) throw this.failComment;
    this.comments.push({ orderId, text });
  }
}

export class FakeLock implements JobLockPort {
  readonly held = new Set<string>();
  readonly acquired: string[] = [];

  async tryAcquire(name: string): Promise<LockHandle | null> {
    if (this.held.has(name)) return null;
    this.held.add(name);
    this.acquired.push(name);
    return { release: async () => void this.held.delete(name) };
  }
}

export class FakeProbe implements HealthProbe {
  constructor(public up = true) {}
  async ping(): Promise<void> {
    if (!this.up) throw new Error('db down');
  }
}

export function event(
  status: TrackingStatus,
  occurredAt: string,
  extra: Partial<Pick<TrackingEvent, 'rawStatus' | 'location'>> = {},
): TrackingEvent {
  return {
    status,
    rawStatus: extra.rawStatus ?? `raw ${status.toLowerCase()}`,
    location: extra.location ?? null,
    occurredAt: new Date(occurredAt),
    rawPayload: { status, occurredAt },
  };
}

export function order(overrides: Partial<CrmOrder> & { id: string }): CrmOrder {
  return {
    trackCode: null,
    deliveryMethod: 'Казпочта',
    status: 'Отправлен',
    customerName: 'Иванов И.',
    updatedAt: new Date('2026-10-30T00:00:00Z'),
    ...overrides,
  };
}
