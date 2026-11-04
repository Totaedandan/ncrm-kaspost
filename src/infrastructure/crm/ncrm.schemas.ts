import { z } from 'zod';

/**
 * NCRM responses are only partially documented (no example JSON), so validation is soft: unknown
 * fields are ignored and every field the docs do not guarantee is optional. See docs/API_NOTES.md.
 */
const idLike = z.union([z.number(), z.string()]);

const contactSchema = z.object({ full_name: z.string().nullish() });

export const dealSchema = z.object({
  id: idLike,
  /** Last modification time, e.g. "2022-08-18T11:35:16.669170" (no timezone). */
  changed: z.string().nullish(),
  created: z.string().nullish(),
  full_name: z.string().nullish(),
  /** A bare id in `GET /api/deals/{id}/`, but an object `{id, stage_name, ...}` in the list. */
  stage_id: z.union([idLike, z.object({ id: idLike })]).nullish(),
  field_values: z.array(z.record(z.string(), z.unknown())).nullish(),
  contact: z.union([contactSchema, z.array(contactSchema)]).nullish(),
});

export type NcrmDeal = z.infer<typeof dealSchema>;

/** The stage id of a deal as text ("" when the deal has none), whichever form the endpoint used. */
export function stageIdOf(deal: NcrmDeal): string {
  const stage = deal.stage_id;
  if (stage === null || stage === undefined) return '';
  return String(typeof stage === 'object' ? stage.id : stage);
}

/** A list endpoint answers either with a bare array or with a DRF-style `{results, next}` page. */
export const dealPageSchema = z.object({
  results: z.array(z.unknown()),
  next: z.string().nullish(),
});

/** The id of the custom field an entry of `field_values` refers to. */
export function fieldIdOf(entry: Record<string, unknown>): string | null {
  for (const key of ['field', 'field_id', 'custom_field']) {
    const value = entry[key];
    if (typeof value === 'number' || typeof value === 'string') return String(value);
    if (typeof value === 'object' && value !== null && 'id' in value) {
      const nested = (value as { id: unknown }).id;
      if (typeof nested === 'number' || typeof nested === 'string') return String(nested);
    }
  }
  return null;
}

/**
 * Unanchored, boundary-guarded, global version of the (anchored) track code pattern, for finding
 * a track inside free comment text.
 */
export function toSearchPattern(pattern: RegExp): RegExp {
  const body = pattern.source.replace(/^\^/, '').replace(/\$$/, '');
  const flags = `${pattern.flags.replace(/[gy]/g, '')}g`;
  return new RegExp(`(?<![A-Za-z0-9])(?:${body})(?![A-Za-z0-9])`, flags);
}

const NOTE_DATE_KEYS = ['created_date', 'created', 'created_at', 'date', 'changed_date', 'changed'] as const;
const MAX_NOTE_DEPTH = 6;

/** Every string anywhere inside a comment: the comment shape is not documented ({"message": "..."} is one guess). */
function collectStrings(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (depth >= MAX_NOTE_DEPTH) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap((item) => collectStrings(item, depth + 1));
  }
  return [];
}

function noteTime(note: unknown): number | null {
  if (typeof note !== 'object' || note === null) return null;
  for (const key of NOTE_DATE_KEYS) {
    const raw = (note as Record<string, unknown>)[key];
    if (typeof raw !== 'string') continue;
    const time = new Date(raw).getTime();
    if (!Number.isNaN(time)) return time;
  }
  return null;
}

/**
 * The track code from the newest comment that contains one (text is upper-cased first, so a track
 * typed in lower case still matches). Newest = latest date when comments carry one, otherwise the
 * last one in the response.
 */
export function newestTrackInNotes(notes: readonly unknown[], search: RegExp): string | null {
  let best: { track: string; time: number | null } | null = null;
  for (const note of notes) {
    const found = collectStrings(note).flatMap((text) => [...text.toUpperCase().matchAll(search)].map((m) => m[0]));
    const track = found[found.length - 1];
    if (track === undefined) continue;

    const time = noteTime(note);
    const older = best !== null && best.time !== null && time !== null && time < best.time;
    if (!older) best = { track, time };
  }
  return best === null ? null : best.track;
}

const TEXT_KEYS = ['value', 'name', 'text', 'label', 'title'] as const;

/** Renders a custom field value (string, number, list option, multi-select...) as plain text. */
export function valueToText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(valueToText).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  if (typeof value === 'object' && value !== null) {
    for (const key of TEXT_KEYS) {
      const text = valueToText((value as Record<string, unknown>)[key]);
      if (text !== null) return text;
    }
  }
  return null;
}
