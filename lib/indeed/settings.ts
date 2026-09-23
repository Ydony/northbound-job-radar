import type { IndeedCountry } from './contracts';
import type { IndeedSettings } from '../types';

export type { IndeedSettings };

/**
 * IND-Next 1: account-scoped Indeed-only place and distance settings.
 *
 * Separate NL and CH place plus distance. Kilometres are the user-facing unit;
 * the provider contract (lib/indeed/client.ts) takes integer MILES, so every
 * search converts explicitly via kmToProviderMiles. The conversion is rounded
 * to the nearest mile because the transport validates integer 0-500.
 *
 * Defaults preserve the behaviour that shipped before this table existed:
 * collection.ts hardcoded NL 'Amsterdam, Netherlands' and CH 'Switzerland'
 * with radiusMiles 10. The km default 16 converts to exactly 10 miles
 * (16 * 0.621371 = 9.94 -> 10), so an account that never touches the setting
 * searches exactly what it searched yesterday.
 *
 * The shared five role inputs (MAX_ROLE_KEYWORDS = 5 in lib/criteria.ts) are
 * unchanged. Indeed still searches only the first two distinct role queries;
 * indeedActiveRoles centralises that slice so collection and the future
 * checkpoint key (#115) cannot drift apart.
 */

export const INDEED_DEFAULT_NL_LOCATION = 'Amsterdam, Netherlands';
export const INDEED_DEFAULT_CH_LOCATION = 'Switzerland';
/** 16 km converts to 10 provider miles, the pre-settings default. */
export const INDEED_DEFAULT_RADIUS_KM = 16;

export const INDEED_LOCATION_MAX_CHARS = 300;
/** User-facing range. 800 km converts to 497 miles, inside the transport's
 * observed 0-500 mile window (client.ts). Anything larger would exceed the
 * evidence; anything smaller would narrow what the provider already accepts. */
export const INDEED_RADIUS_KM_MIN = 0;
export const INDEED_RADIUS_KM_MAX = 800;

/** Bump when the upstream query shape changes so checkpoint keys (#115) miss
 * rather than reuse coverage from a different query. */
export const INDEED_QUERY_VERSION = 2;

const MILES_PER_KM = 0.621371;

/** Kilometres (user unit) to provider miles, rounded to the transport's integer. */
export function kmToProviderMiles(radiusKm: number): number {
  return Math.round(radiusKm * MILES_PER_KM);
}

/** Provider miles back to kilometres for display. Not used for storage. */
export function providerMilesToKm(radiusMiles: number): number {
  return Math.round(radiusMiles / MILES_PER_KM);
}

export function defaultIndeedSettings(): IndeedSettings {
  return {
    nlLocation: INDEED_DEFAULT_NL_LOCATION,
    nlRadiusKm: INDEED_DEFAULT_RADIUS_KM,
    chLocation: INDEED_DEFAULT_CH_LOCATION,
    chRadiusKm: INDEED_DEFAULT_RADIUS_KM,
    updatedAt: '',
  };
}

function cleanLocation(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.trim().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > INDEED_LOCATION_MAX_CHARS) return fallback;
  return cleaned;
}

function cleanRadiusKm(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (!Number.isInteger(value)) return fallback;
  if (value < INDEED_RADIUS_KM_MIN || value > INDEED_RADIUS_KM_MAX) return fallback;
  return value;
}

interface IndeedSettingsRow {
  nl_location?: unknown;
  nl_radius_km?: unknown;
  ch_location?: unknown;
  ch_radius_km?: unknown;
  updated_at?: unknown;
}

/**
 * Missing row (brand-new account, or a database predating migration 26) reads
 * as defaults, never as empty. An empty place would fail transport validation
 * and silently search nothing; defaults keep yesterday's coverage.
 */
export function indeedSettingsFromRow(row: IndeedSettingsRow | null): IndeedSettings {
  if (!row) return defaultIndeedSettings();
  return {
    nlLocation: cleanLocation(row.nl_location, INDEED_DEFAULT_NL_LOCATION),
    nlRadiusKm: cleanRadiusKm(row.nl_radius_km, INDEED_DEFAULT_RADIUS_KM),
    chLocation: cleanLocation(row.ch_location, INDEED_DEFAULT_CH_LOCATION),
    chRadiusKm: cleanRadiusKm(row.ch_radius_km, INDEED_DEFAULT_RADIUS_KM),
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
  };
}

export interface CleanedIndeedSettingsInput {
  nlLocation: string;
  nlRadiusKm: number;
  chLocation: string;
  chRadiusKm: number;
}

/**
 * Strict server-side validation for PUT. Unlike indeedSettingsFromRow (which
 * repairs corrupt rows to defaults on read), this refuses invalid input so a
 * typo never silently becomes Amsterdam. Throws with a user-facing message.
 */
export function cleanIndeedSettingsInput(body: Record<string, unknown>): CleanedIndeedSettingsInput {
  const places: Array<[unknown, string]> = [
    [body.nlLocation, 'Netherlands place'],
    [body.chLocation, 'Switzerland place'],
  ];
  for (const [value, label] of places) {
    if (typeof value !== 'string') throw new Error(`${label} must be text.`);
    const cleaned = value.trim().replace(/\s+/g, ' ');
    if (!cleaned) throw new Error(`${label} must not be empty.`);
    if (cleaned.length > INDEED_LOCATION_MAX_CHARS) {
      throw new Error(`${label} must be at most ${INDEED_LOCATION_MAX_CHARS} characters.`);
    }
  }
  const radii: Array<[unknown, string]> = [
    [body.nlRadiusKm, 'Netherlands distance'],
    [body.chRadiusKm, 'Switzerland distance'],
  ];
  for (const [value, label] of radii) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${label} must be a number in kilometres.`);
    }
    if (!Number.isInteger(value)) throw new Error(`${label} must be a whole number of kilometres.`);
    if (value < INDEED_RADIUS_KM_MIN || value > INDEED_RADIUS_KM_MAX) {
      throw new Error(`${label} must be between ${INDEED_RADIUS_KM_MIN} and ${INDEED_RADIUS_KM_MAX} km.`);
    }
  }
  const nlLocation = (body.nlLocation as string).trim().replace(/\s+/g, ' ');
  const chLocation = (body.chLocation as string).trim().replace(/\s+/g, ' ');
  return { nlLocation, nlRadiusKm: body.nlRadiusKm as number, chLocation, chRadiusKm: body.chRadiusKm as number };
}

export function indeedSearchLocation(country: IndeedCountry, settings: IndeedSettings): string {
  return country === 'NL' ? settings.nlLocation : settings.chLocation;
}

export function indeedSearchRadiusMiles(country: IndeedCountry, settings: IndeedSettings): number {
  const radiusKm = country === 'NL' ? settings.nlRadiusKm : settings.chRadiusKm;
  return kmToProviderMiles(radiusKm);
}

/**
 * First TWO distinct saved role queries only. The shared inputs still hold up
 * to five (MAX_ROLE_KEYWORDS); Indeed deliberately sends two. Trimmed and
 * deduplicated case-insensitively so 'Data Analyst' and 'data analyst ' count
 * once, in first-seen order.
 */
export function indeedActiveRoles(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const roles: string[] = [];
  for (const term of terms) {
    if (typeof term !== 'string') continue;
    const cleaned = term.trim().replace(/\s+/g, ' ');
    if (!cleaned) continue;
    const key = cleaned.toLocaleLowerCase('en');
    if (seen.has(key)) continue;
    seen.add(key);
    roles.push(cleaned);
    if (roles.length === 2) break;
  }
  return roles;
}

/**
 * Canonical query identity for checkpoint keying (#115). Any change to owner,
 * role query, country, place, provider radius or query version produces a
 * different key, so coverage checkpoints never apply to a different query.
 * Normalised (trimmed, lowercased place/role) so cosmetic edits still hit the
 * same checkpoint only when they truly match; a real place or radius change
 * always misses and starts fresh coverage.
 */
export function indeedQueryIdentity(input: {
  userId: string;
  country: IndeedCountry;
  role: string;
  location: string;
  radiusMiles: number;
}): string {
  const role = input.role.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
  const location = input.location.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
  return [
    `indeed/v${INDEED_QUERY_VERSION}`,
    input.userId,
    input.country,
    role,
    location,
    String(input.radiusMiles),
  ].join('\n');
}

/** Load this account's settings, or defaults when the row is absent. */
export async function loadIndeedSettings(db: D1Database, userId: string): Promise<IndeedSettings> {
  const row = await db.prepare('SELECT nl_location, nl_radius_km, ch_location, ch_radius_km, updated_at FROM indeed_settings WHERE user_id = ?')
    .bind(userId).first<IndeedSettingsRow>();
  return indeedSettingsFromRow(row);
}
