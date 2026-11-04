import type { TrackingEvent } from '../../domain/tracking-event';

export interface TrackingPort {
  /**
   * Full event history of a parcel. An empty array means "no information yet" (not an error).
   * @throws ExternalServiceError on transport failures
   * @throws ExternalSchemaError when the response does not match the expected shape
   */
  fetchEvents(trackCode: string): Promise<TrackingEvent[]>;
}
