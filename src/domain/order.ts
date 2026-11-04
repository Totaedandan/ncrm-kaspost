/** An order as the CRM port exposes it. Mirrors SPEC §8.2. */
export interface CrmOrder {
  id: string;
  trackCode: string | null;
  deliveryMethod: string | null;
  status: string;
  customerName?: string;
  updatedAt: Date;
}
