import type { CrmOrderPage, CrmPort } from '../../application/ports/crm.port';
import type { CrmOrder } from '../../domain/order';

export interface MockCrmCall {
  kind: 'status' | 'comment';
  orderId: string;
  value: string;
}

const KAZPOST = 'Казпочта';
const COURIER = 'Курьер';

const SEED_UPDATED_AT = new Date('2026-01-01T00:00:00Z');

function seedOrders(): CrmOrder[] {
  return [
    { id: '1042', trackCode: 'RR123456789KZ', deliveryMethod: KAZPOST, status: 'Отправлен', customerName: 'Иванов И.', updatedAt: SEED_UPDATED_AT },
    { id: '1043', trackCode: 'CP987654321KZ', deliveryMethod: KAZPOST, status: 'Отправлен', customerName: 'Петрова А.', updatedAt: SEED_UPDATED_AT },
    { id: '1044', trackCode: 'RB555444333KZ', deliveryMethod: KAZPOST, status: 'Отправлен', customerName: 'Сидоров К.', updatedAt: SEED_UPDATED_AT },
    { id: '1045', trackCode: null, deliveryMethod: COURIER, status: 'Отправлен', customerName: 'Ахметов Б.', updatedAt: SEED_UPDATED_AT },
    { id: '1046', trackCode: null, deliveryMethod: COURIER, status: 'Новый', customerName: 'Смирнова Е.', updatedAt: SEED_UPDATED_AT },
    { id: '1047', trackCode: 'not-a-track', deliveryMethod: KAZPOST, status: 'Отправлен', customerName: 'Орлов Д.', updatedAt: SEED_UPDATED_AT },
  ];
}

/** In-memory CRM for development until the NCRM API docs arrive. */
export class MockCrmAdapter implements CrmPort {
  readonly calls: MockCrmCall[] = [];
  private orders: CrmOrder[];

  constructor(
    orders: readonly CrmOrder[] = seedOrders(),
    private readonly pageSize = 50,
  ) {
    this.orders = [...orders];
  }

  async *listOrdersUpdatedSince(cursor: string | null): AsyncIterable<CrmOrderPage> {
    const threshold = cursor === null ? null : new Date(cursor);
    const matching = this.orders.filter((o) => threshold === null || o.updatedAt >= threshold);
    for (let i = 0; i < matching.length; i += this.pageSize) {
      yield { orders: matching.slice(i, i + this.pageSize) };
    }
  }

  async getOrderStatus(orderId: string): Promise<string | null> {
    return this.orders.find((o) => o.id === orderId)?.status ?? null;
  }

  async updateOrderStatus(orderId: string, crmStatusId: string): Promise<void> {
    this.requireOrder(orderId);
    this.calls.push({ kind: 'status', orderId, value: crmStatusId });
  }

  async addOrderComment(orderId: string, text: string): Promise<void> {
    this.requireOrder(orderId);
    this.calls.push({ kind: 'comment', orderId, value: text });
  }

  /** Test/dev helper: insert or replace an order. */
  upsertOrder(order: CrmOrder): void {
    this.orders = [...this.orders.filter((o) => o.id !== order.id), order];
  }

  private requireOrder(orderId: string): void {
    if (!this.orders.some((o) => o.id === orderId)) throw new Error(`Mock CRM: unknown order ${orderId}`);
  }
}
