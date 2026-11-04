import { InvalidTrackCodeError } from './errors';

/** UPU S10 format; overridable through TRACK_CODE_REGEX. */
export const DEFAULT_TRACK_CODE_PATTERN = /^[A-Z]{2}\d{9}[A-Z]{2}$/;

export class TrackCode {
  private constructor(public readonly value: string) {}

  static tryParse(raw: string | null | undefined, pattern: RegExp): TrackCode | null {
    if (raw === null || raw === undefined) return null;
    const normalized = raw.trim().toUpperCase();
    if (normalized === '') return null;
    return pattern.test(normalized) ? new TrackCode(normalized) : null;
  }

  static parse(raw: string, pattern: RegExp): TrackCode {
    const parsed = TrackCode.tryParse(raw, pattern);
    if (parsed === null) throw new InvalidTrackCodeError(raw);
    return parsed;
  }

  toString(): string {
    return this.value;
  }
}
