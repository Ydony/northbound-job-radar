export interface JobsCursor {
  updatedAt: string;
  id: string;
}

/**
 * Keyset cursor for the jobs page, opaque to the client and plain to the server:
 * `updatedAt|id` of the last row of the previous page. Keyset rather than offset, so jobs
 * imported between two page loads shift what follows rather than skipping a row outright.
 * Neither half ever contains '|' (ISO timestamps and UUIDs), and newlines are refused so a
 * crafted value cannot smuggle a second line into a logged query.
 */
export function encodeJobsCursor(updatedAt: string, id: string) {
  return `${updatedAt}|${id}`;
}

export function decodeJobsCursor(raw: string | null): { cursor: JobsCursor | null; error: string | null } {
  if (raw === null || raw === '') return { cursor: null, error: null };
  const separator = raw.lastIndexOf('|');
  const updatedAt = separator < 0 ? '' : raw.slice(0, separator);
  const id = separator < 0 ? '' : raw.slice(separator + 1);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(updatedAt) || !id || raw.includes('\n')) {
    return { cursor: null, error: 'Cursor is not a value this endpoint returned.' };
  }
  return { cursor: { updatedAt, id }, error: null };
}

/** Null means "no parameter", which reads as the default page size rather than an error.
 *  The default is separate from the ceiling: a caller may ask for far more than a page
 *  shows, but should not be handed it for not having asked. */
export function parsePageLimit(raw: string | null, max: number, fallback = max): { size: number; error: string | null } {
  if (raw === null) return { size: Math.min(fallback, max), error: null };
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 1 || size > max) {
    return { size: 0, error: `Limit must be a whole number from 1 to ${max}.` };
  }
  return { size, error: null };
}
