import type { CrmOrderPage, CrmPort } from '../../application/ports/crm.port';
import { ExternalSchemaError, ExternalServiceError } from '../../domain/errors';
import type { CrmOrder } from '../../domain/order';
import { createLimiter, type Limiter } from '../../shared/concurrency';
import type { HttpRequest, HttpResponse } from '../http/http-client';
import {
  dealPageSchema,
  dealSchema,
  fieldIdOf,
  newestTrackInNotes,
  stageIdOf,
  toSearchPattern,
  valueToText,
  type NcrmDeal,
} from './ncrm.schemas';

const SERVICE = 'ncrm';
const MAX_PAGES = 500;
const MAX_NOTE_PAGES = 20;
const NOTES_CONCURRENCY = 3;
const OK_STATUSES = new Set([200, 201, 202, 204]);

export interface NcrmHttp {
  request(url: string, request?: HttpRequest): Promise<HttpResponse>;
}

export interface NcrmAdapterOptions {
  /** Account host, e.g. "cloud.ncrm.pro" or "https://acme.ncrm.kz". */
  baseUrl: string;
  /** Personal API token (Profile -> "Ваш API token"). Sent as the `api_token` query parameter. */
  apiKey: string;
  /** Id of the custom field holding the track code; null when tracks are read from comments. */
  trackFieldId: number | null;
  /** Id of the custom field holding the delivery method; null when the CRM has none. */
  deliveryFieldId: number | null;
  /** Only deals in this stage (the "НА ДОСТАВКЕ" column) are returned; null/omitted = every stage. */
  sourceStageId?: string | null;
  /** Pilot switch: when set, only these deal ids are returned (everything else is left alone). */
  onlyOrderIds?: ReadonlySet<string> | null;
  /**
   * When set, a deal without a track custom field gets its track code from the newest comment
   * containing one. The pattern is the (anchored) track code regex; it is applied to comment text.
   */
  trackCommentPattern?: RegExp | null;
  http: NcrmHttp;
}

/**
 * NCRM has no "order" entity: an order is a deal, its status is the deal's stage.
 * Transport and mapping only; deciding which deals matter is the use cases' job.
 * Assumptions not covered by the vendor docs are listed in docs/API_NOTES.md.
 */
export class NcrmAdapter implements CrmPort {
  private readonly origin: string;
  private readonly commentSearch: RegExp | null;
  private readonly limitNotes: Limiter = createLimiter(NOTES_CONCURRENCY);

  constructor(private readonly options: NcrmAdapterOptions) {
    this.origin = normalizeOrigin(options.baseUrl);
    this.commentSearch = options.trackCommentPattern ? toSearchPattern(options.trackCommentPattern) : null;
  }

  /**
   * The API documents no pagination and no filter by modification time, so every deal is fetched
   * and filtered here (by stage and `changed`). DRF-style `{results, next}` pages are followed when present.
   * When tracks live in comments the cursor is ignored: adding a comment may not bump `changed`,
   * so every deal of the source stage is re-read on each run (the use cases are idempotent).
   */
  async *listOrdersUpdatedSince(cursor: string | null): AsyncIterable<CrmOrderPage> {
    const threshold = cursor === null || this.commentSearch !== null ? null : new Date(cursor);
    const sourceStage = this.options.sourceStageId ?? null;
    const only = this.options.onlyOrderIds ?? null;
    const visited = new Set<string>();
    // NCRM filters by stage on its side (`?stage=`); the client-side check below is a safety net.
    let url: string | null = this.url('/api/deals/', sourceStage === null ? {} : { stage: sourceStage });

    while (url !== null) {
      if (visited.has(url) || visited.size >= MAX_PAGES) {
        throw new ExternalSchemaError(SERVICE, 'pagination does not terminate', '');
      }
      visited.add(url);

      const { items, next } = splitPage(await this.getJson(url));
      const candidates = items
        .map((item) => this.toOrder(item))
        .filter((order) => sourceStage === null || order.status === sourceStage)
        .filter((order) => only === null || only.has(order.id))
        .filter((order) => threshold === null || order.updatedAt >= threshold);
      const orders = await Promise.all(candidates.map((order) => this.withCommentTrack(order)));
      yield { orders };
      url = next === null ? null : this.sameOriginUrl(next);
    }
  }

  /** Current stage id of the deal; null when the deal no longer exists. */
  async getOrderStatus(orderId: string): Promise<string | null> {
    const response = await this.send(this.url(`/api/deals/${encodeURIComponent(orderId)}/`), { headers: this.jsonHeaders() });
    if (response.status === 404) return null;
    this.requireOk(response, `read deal ${orderId}`);
    const parsed = dealSchema.safeParse(parseJson(response));
    if (!parsed.success) {
      throw new ExternalSchemaError(SERVICE, `unexpected deal shape: ${parsed.error.message}`, '');
    }
    return stageIdOf(parsed.data);
  }

  async updateOrderStatus(orderId: string, crmStatusId: string): Promise<void> {
    const response = await this.send(this.url('/api/deals/change_stage/'), {
      method: 'PATCH',
      headers: this.jsonHeaders(),
      body: JSON.stringify({ stage_id: numericOrText(crmStatusId), ids: [numericOrText(orderId)] }),
    });
    this.requireOk(response, `change stage of deal ${orderId}`);
  }

  /** Unconfirmed by the docs for deals (only documented for contacts): treated as best-effort by callers. */
  async addOrderComment(orderId: string, text: string): Promise<void> {
    const form = new FormData();
    form.append('text', JSON.stringify({ message: text }));
    const response = await this.send(this.url(`/api/notes/deals/${encodeURIComponent(orderId)}/`), {
      method: 'POST',
      headers: { referer: `${this.origin}/` },
      body: form,
      retries: 0, // not idempotent: a retry could post the comment twice
    });
    this.requireOk(response, `comment deal ${orderId}`);
  }

  /** Setup helper for `pnpm ncrm:inspect`: pipelines with stages, and custom fields with their ids. */
  async describeSetup(): Promise<{ funnels: unknown; customFields: unknown }> {
    const [funnels, customFields] = await Promise.all([
      this.getJson(this.url('/api/deals/funnels/')),
      this.getJson(this.url('/api/custom_fields/')),
    ]);
    return { funnels, customFields };
  }

  /** Setup helper for `pnpm ncrm:inspect <dealId>`: raw deal and comments, to check the response shapes. */
  async describeDeal(dealId: string): Promise<{ deal: unknown; notes: unknown[] }> {
    const id = encodeURIComponent(dealId);
    const deal = await this.getJson(this.url(`/api/deals/${id}/`));
    return { deal, notes: await this.listNotes(dealId) };
  }

  /** Fills in the track code from the deal's comments when the custom field gave none. */
  private async withCommentTrack(order: CrmOrder): Promise<CrmOrder> {
    if (this.commentSearch === null || order.trackCode !== null) return order;
    const notes = await this.limitNotes(() => this.listNotes(order.id));
    const trackCode = newestTrackInNotes(notes, this.commentSearch);
    return trackCode === null ? order : { ...order, trackCode };
  }

  /** `GET /api/notes/deals/{id}/` is not in the vendor docs (only contacts are): see docs/API_NOTES.md. */
  private async listNotes(dealId: string): Promise<unknown[]> {
    const notes: unknown[] = [];
    const visited = new Set<string>();
    let url: string | null = this.url(`/api/notes/deals/${encodeURIComponent(dealId)}/`);

    while (url !== null) {
      if (visited.has(url) || visited.size >= MAX_NOTE_PAGES) {
        throw new ExternalSchemaError(SERVICE, `comments of deal ${dealId}: pagination does not terminate`, '');
      }
      visited.add(url);
      const { items, next } = splitPage(await this.getJson(url));
      notes.push(...items);
      url = next === null ? null : this.sameOriginUrl(next);
    }
    return notes;
  }

  private toOrder(item: unknown): CrmOrder {
    const parsed = dealSchema.safeParse(item);
    if (!parsed.success) {
      throw new ExternalSchemaError(SERVICE, `unexpected deal shape: ${parsed.error.message}`, shapeOf(item));
    }
    const deal = parsed.data;
    const updatedAt = parseNcrmDate(deal.changed) ?? parseNcrmDate(deal.created);
    if (updatedAt === null) {
      throw new ExternalSchemaError(SERVICE, `deal ${deal.id} has no parsable "changed" date`, shapeOf(item));
    }

    const customerName = customerNameOf(deal);
    return {
      id: String(deal.id),
      trackCode: this.options.trackFieldId === null ? null : this.customFieldText(deal, this.options.trackFieldId),
      deliveryMethod:
        this.options.deliveryFieldId === null ? null : this.customFieldText(deal, this.options.deliveryFieldId),
      status: stageIdOf(deal),
      ...(customerName === null ? {} : { customerName }),
      updatedAt,
    };
  }

  private customFieldText(deal: NcrmDeal, fieldId: number): string | null {
    for (const entry of deal.field_values ?? []) {
      if (fieldIdOf(entry) === String(fieldId)) return valueToText(entry['value']);
    }
    return null;
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.send(url, { headers: this.jsonHeaders() });
    this.requireOk(response, 'request');
    return parseJson(response);
  }

  private send(url: string, request: HttpRequest): Promise<HttpResponse> {
    return this.options.http.request(url, request);
  }

  private requireOk(response: HttpResponse, action: string): void {
    if (OK_STATUSES.has(response.status)) return;
    const hint = response.status === 401 || response.status === 403 ? ' (check NCRM_API_KEY and its permissions)' : '';
    throw new ExternalServiceError(SERVICE, `${action}: HTTP ${response.status}${hint}`);
  }

  private jsonHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', referer: `${this.origin}/` };
  }

  private url(path: string, query: Readonly<Record<string, string>> = {}): string {
    const params = new URLSearchParams({ api_token: this.options.apiKey, ...query });
    return `${this.origin}${path}?${params.toString()}`;
  }

  /** A `next` link must stay on the NCRM host (the token travels in the URL) and keep the token. */
  private sameOriginUrl(link: string): string {
    const resolved = new URL(link, `${this.origin}/`);
    if (resolved.origin !== this.origin) {
      throw new ExternalSchemaError(SERVICE, 'pagination link points to a different host', '');
    }
    resolved.searchParams.set('api_token', this.options.apiKey);
    return resolved.toString();
  }
}

export function normalizeOrigin(baseUrl: string): string {
  const withScheme = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  return new URL(withScheme).origin;
}

function parseJson(response: HttpResponse): unknown {
  try {
    return JSON.parse(response.text);
  } catch {
    throw new ExternalSchemaError(SERVICE, 'response is not valid JSON', '');
  }
}

function splitPage(body: unknown): { items: unknown[]; next: string | null } {
  if (Array.isArray(body)) return { items: body, next: null };
  const page = dealPageSchema.safeParse(body);
  if (page.success) return { items: page.data.results, next: page.data.next ?? null };
  throw new ExternalSchemaError(SERVICE, 'deal list is neither an array nor a {results} page', shapeOf(body));
}

/** NCRM sends timestamps like "2022-08-18T11:35:16.669170" without a zone; the same parsing is used for cursor and comparison. */
function parseNcrmDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function customerNameOf(deal: NcrmDeal): string | null {
  const contact = Array.isArray(deal.contact) ? deal.contact[0] : deal.contact;
  const name = contact?.full_name?.trim();
  return name ? name : null;
}

function numericOrText(value: string): number | string {
  return /^\d+$/.test(value) ? Number(value) : value;
}

/** Only the shape (keys) of unexpected data goes into alerts: deals contain customer personal data. */
function shapeOf(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object' && value !== null) return `keys: ${Object.keys(value).join(', ')}`;
  return typeof value;
}
