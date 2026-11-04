import type { TrackingStatus } from '../../domain/tracking-status';
import { KAZPOST_CODES } from './kazpost-status-codes';

export type CodeMapping =
  | { kind: 'visible'; status: TrackingStatus; label: string }
  /** Documented as "do not translate to the customer-facing service": carries no status. */
  | { kind: 'hidden'; label: string }
  /** Not in the official dictionary: needs a developer (UNKNOWN + DEV_ALERT upstream). */
  | { kind: 'unknown' };

/** Retraction codes such as ISSPAY_UNDO / ISSPAY_UNDO_I cancel an earlier event of the base code. */
const UNDO_PATTERN = /_UNDO(?=(_[IO])?$)/;

export function mapKazpostCode(code: string): CodeMapping {
  const info = Object.hasOwn(KAZPOST_CODES, code) ? KAZPOST_CODES[code] : undefined;
  if (info === undefined) return { kind: 'unknown' };
  if (info.status === null) return { kind: 'hidden', label: info.label };
  return { kind: 'visible', status: info.status, label: info.label };
}

/** The code of the event a retraction cancels (ISSPAY_UNDO_I -> ISSPAY_I), or null if not a retraction. */
export function undoTarget(code: string): string | null {
  return UNDO_PATTERN.test(code) ? code.replace(UNDO_PATTERN, '') : null;
}
