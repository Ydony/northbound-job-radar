import { createIndeedClient } from './client';
import { indeedReadiness } from './auth';
import { normalizeIndeed } from './normalize';
import type { IndeedCountry } from './contracts';
import type { ParsedJob } from '../jobsch';
import { delay } from '../jobsch';
import type { SourceRunStatus } from '../types';

type Configuration = Parameters<typeof createIndeedClient>[0];
interface Control { paused: number; cooldown_until: number; lease_until: number; last_success: string }
export interface IndeedBatchResult {
  jobs: ParsedJob[]; status: SourceRunStatus; message: string; roles: string[];
  retrieved: number; rejected: number; duplicates: number; requests: number;
}
export type IndeedStatus = { state: string; lastSuccess: string; retryAfterSeconds: number };

export async function indeedStatus(db: D1Database, config: Configuration): Promise<IndeedStatus> {
  const readiness = indeedReadiness(config.access, config.credentials);
  const base = { lastSuccess: '', retryAfterSeconds: 0 };
  if (readiness !== 'ready') return { ...base, state: readiness };
  const row = await db.prepare("SELECT * FROM indeed_control WHERE id = 'indeed'").first<Control>();
  if (!row) return { ...base, state: 'unavailable' };
  const retryAfterSeconds = Math.max(0, Math.ceil((row.cooldown_until - Date.now()) / 1000));
  return { lastSuccess: row.last_success, retryAfterSeconds,
    state: row.paused ? 'refused' : retryAfterSeconds ? 'cooldown' : row.lease_until > Date.now() ? 'busy'
      : row.last_success ? 'connected' : 'ready' };
}

/** One lease and a maximum of FOUR requests across both countries and all terms. */
export async function collectIndeed(db: D1Database, config: Configuration,
  terms: string[], signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<Record<IndeedCountry, IndeedBatchResult>> {
  const empty = (): IndeedBatchResult => ({ jobs: [], status: 'disabled', message: '', roles: [], retrieved: 0, rejected: 0, duplicates: 0, requests: 0 });
  const results = { NL: empty(), CH: empty() };
  const status = await indeedStatus(db, config);
  if (!['ready', 'connected'].includes(status.state)) {
    for (const value of Object.values(results)) {
      value.status = status.state === 'disabled' ? 'disabled' : status.state === 'refused' ? 'blocked' : 'unavailable';
      value.message = `Indeed: ${status.state.replaceAll('_', ' ')}.${status.retryAfterSeconds ? ` Retry after ${status.retryAfterSeconds} seconds.` : ''}`;
    }
    return results;
  }
  const token = crypto.randomUUID();
  const now = Date.now();
  const locked = await db.prepare(`UPDATE indeed_control SET lease_token = ?, lease_until = ?
    WHERE id = 'indeed' AND paused = 0 AND cooldown_until <= ? AND lease_until <= ?`)
    .bind(token, now + 180_000, now, now).run();
  if (!locked.meta.changes) {
    for (const value of Object.values(results)) { value.status = 'unavailable'; value.message = 'Indeed is busy, paused or cooling down.'; }
    return results;
  }
  // A crash retains the lease for three minutes; a normal finish also imposes a fixed cooldown.
  const client = createIndeedClient(config, fetcher);
  const selected = [...new Set(terms.map(term => term.trim()).filter(Boolean))].slice(0, 2);
  let stopped = '';
  let requestsMade = 0;
  try {
    for (const country of ['NL', 'CH'] as const) {
      const value = results[country];
      value.status = 'complete';
      const seen = new Set<string>();
      for (const term of selected) {
        if (stopped || signal?.aborted) { value.status = value.jobs.length ? 'partial' : 'unavailable'; break; }
        if (requestsMade) await delay(500);
        const response = await client.search({ country, keywords: term,
          location: country === 'NL' ? 'Amsterdam, Netherlands' : 'Switzerland',
          pageSize: 25, maxJobs: 25, maxRequests: 1, signal });
        value.roles.push(term);
        value.requests += response.requestsMade;
        requestsMade += response.requestsMade;
        value.retrieved += response.responseRows;
        value.rejected += response.rejectedRows;
        value.duplicates += response.duplicateRows;
        for (const record of response.jobs) {
          const parsed = normalizeIndeed(record, country);
          if (!parsed) { value.rejected++; continue; }
          if (seen.has(parsed.sourceUrl)) { value.duplicates++; continue; }
          seen.add(parsed.sourceUrl); value.jobs.push(parsed);
        }
        if (response.outcome !== 'complete' || value.rejected || terms.length > selected.length) value.status = 'partial';
        if (response.reason === 'access_refused' || response.reason === 'redirect_refused' || response.reason === 'invalid_response') {
          stopped = 'access refused or unexpected response; paused pending operator review';
          await db.prepare("UPDATE indeed_control SET paused = 1 WHERE id = 'indeed' AND lease_token = ?").bind(token).run();
          value.status = value.jobs.length ? 'partial' : 'blocked';
        } else if (response.reason === 'rate_limited') {
          stopped = 'rate limited';
          const until = Date.now() + Math.max(60, response.retryAfterSeconds ?? 60) * 1000;
          await db.prepare("UPDATE indeed_control SET cooldown_until = max(cooldown_until, ?) WHERE id = 'indeed' AND lease_token = ?").bind(until, token).run();
          value.status = value.jobs.length ? 'partial' : 'unavailable';
        } else if (!['end_of_results', 'budget_exhausted'].includes(response.reason)) {
          stopped = response.reason.replaceAll('_', ' '); value.status = value.jobs.length ? 'partial' : 'failed';
        } else {
          await db.prepare("UPDATE indeed_control SET last_success = ? WHERE id = 'indeed' AND lease_token = ?")
            .bind(new Date().toISOString(), token).run();
        }
      }
      value.message = `${value.requests} request(s), ${value.retrieved} returned row(s). ${stopped || 'Bounded sample; more results may exist.'} Description completeness unverified.${terms.length > selected.length ? ' Only the first two role keywords were searched.' : ''}`;
    }
    return results;
  } finally {
    await db.prepare(`UPDATE indeed_control SET lease_token = '', lease_until = 0,
      cooldown_until = max(cooldown_until, ?) WHERE id = 'indeed' AND lease_token = ?`)
      .bind(Date.now() + 60_000, token).run();
  }
}
