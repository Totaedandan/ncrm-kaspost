import type { CrmOrder } from '../../domain/order';

export type { CrmOrder };

export interface CrmOrderPage {
  orders: CrmOrder[];
}

export interface CrmPort {
  /**
   * Orders whose `updatedAt` is >= the cursor (ISO timestamp), or all active orders when null.
   * Boundary orders may be returned again: consumers must be idempotent.
   */
  listOrdersUpdatedSince(cursor: string | null): AsyncIterable<CrmOrderPage>;
  /** Current CRM status (stage) id of the order, or null when the order no longer exists. */
  getOrderStatus(orderId: string): Promise<string | null>;
  updateOrderStatus(orderId: string, crmStatusId: string): Promise<void>;
  addOrderComment(orderId: string, text: string): Promise<void>;
}
