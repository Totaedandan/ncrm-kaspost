import type { TrackingPort } from '../../application/ports/tracking.port';
import { ExternalSchemaError, ExternalServiceError } from '../../domain/errors';
import type { TrackingEvent } from '../../domain/tracking-event';
import type { HttpClient } from '../http/http-client';
import { decodeKazpostEvents } from './kazpost-events.decoder';
import { kazpostResponseSchema } from './kazpost.schemas';

const SERVICE = 'kazpost';
const SAMPLE_LENGTH = 500;
/** "Отсутствует информация по данному трек номеру ..." (older deployments answered in English). */
const NO_INFORMATION = /информаци|information/i;

export interface KazpostAdapterOptions {
  baseUrl: string;
  http: Pick<HttpClient, 'get'>;
}

/** Transport + DTO -> domain mapping only. Decisions about what the events mean live in the use cases. */
export class KazpostAdapter implements TrackingPort {
  constructor(private readonly options: KazpostAdapterOptions) {}

  async fetchEvents(trackCode: string): Promise<TrackingEvent[]> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(trackCode)}/events`;
    const response = await this.options.http.get(url);

    if (response.status >= 400) {
      throw new ExternalServiceError(SERVICE, `HTTP ${response.status} for ${trackCode}`);
    }
    return this.parse(response.text);
  }

  private parse(text: string): TrackingEvent[] {
    const sample = text.slice(0, SAMPLE_LENGTH);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ExternalSchemaError(SERVICE, 'response is not valid JSON', sample);
    }

    const parsed = kazpostResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ExternalSchemaError(SERVICE, `unexpected response shape: ${parsed.error.message}`, sample);
    }

    const { events, error } = parsed.data;
    if (events !== undefined) return decodeKazpostEvents(events, sample);
    if (error !== undefined && NO_INFORMATION.test(error)) return [];
    throw new ExternalSchemaError(
      SERVICE,
      error !== undefined ? `API error: ${error}` : 'response has neither "events" nor "error"',
      sample,
    );
  }
}
