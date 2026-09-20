#!/usr/bin/env node
/**
 * Discover employer job-board candidates from the public Common Crawl index.
 *
 * Where the data comes from
 * --------------------------
 * 1. `https://index.commoncrawl.org/collinfo.json` lists the available crawls. The script reads
 *    it at runtime and uses the newest two crawls; no crawl id is hardcoded.
 * 2. For each board system the app already supports it queries the public Common Crawl CDX index
 *    (`https://index.commoncrawl.org/CC-MAIN-<id>-index?url=<pattern>&output=json`) and pulls the
 *    company identifier out of every captured URL (first path segment for Greenhouse, Lever and
 *    Ashby; subdomain for Recruitee, Personio and Teamtailor).
 * 3. Each candidate is verified against that employer's own public feed, using the same feed URL
 *    shapes as `lib/ats-feeds.ts` `feedUrl`. A board is kept only if the feed answers, holds at
 *    least one posting located in the Netherlands or Switzerland, and that posting carries at
 *    least 900 characters of text (the length the language gate needs to judge it).
 *
 * Known limitation: Common Crawl does not crawl `jobs.lever.co`, so Lever coverage from this
 * route is near zero. An empty Lever result means the index has nothing to offer, not that no
 * Lever boards exist. Do not read the output as a complete list of employer boards.
 *
 * What this script does NOT do
 * ----------------------------
 * - It never edits the employer list. It writes `scripts/output/discovered-boards.csv`, a list
 *   of leads for a human to verify before any employer is added to `lib/ats-feeds.ts`.
 * - It never runs inside a search request. It is a manually triggered local script.
 * - It writes only its CSV, which defaults inside `scripts/output/`. `--output` can point that
 *   anywhere, so this is where the output goes by default, not an invariant the code enforces.
 *   It edits nothing else. It reads public CDX indexes and public employer
 *   feeds only: no logins, no HTML job-page scraping, no detection evasion.
 *
 * Politeness: the Common Crawl index is queried one request at a time - it is a single shared
 * service and asks for no parallel threads - while feed verification stays at 4 in flight
 * because those go to many different employers. A minimum gap between request starts, a real
 * User-Agent naming this tool, and a per-request timeout. One bad board or one failed index
 * page never stops the run; failures are counted and reported.
 *
 * Usage: `node scripts/discover-boards.mjs --help`
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');

const USER_AGENT =
  'ik-ben-een-appel-board-discovery/1.0 (+https://github.com/Ydony/northbound-job-radar; local employer-board research)';

/** Index patterns, one per board system the app supports. */
const PATTERNS = [
  { platform: 'greenhouse', pattern: 'boards.greenhouse.io/*' },
  { platform: 'greenhouse', pattern: 'job-boards.greenhouse.io/*' },
  { platform: 'ashby', pattern: 'jobs.ashbyhq.com/*' },
  { platform: 'lever', pattern: 'jobs.lever.co/*' },
  { platform: 'recruitee', pattern: '*.recruitee.com' },
  { platform: 'personio', pattern: '*.jobs.personio.de' },
  { platform: 'teamtailor', pattern: '*.teamtailor.com' },
  { platform: 'workable', pattern: 'apply.workable.com/*' },
];

const DEFAULTS = {
  crawls: 2,
  maxPages: 5,
  maxVerify: 0, // 0 = verify every candidate
  delayMs: 300,
  timeoutMs: 15_000,
  output: resolve(scriptDir, 'output', 'discovered-boards.csv'),
};

const NL_HINT =
  /\bnetherlands\b|\bnederland\b|\bholland\b|\bamsterdam\b|\brotterdam\b|\butrecht\b|\beindhoven\b|\bthe hague\b|\bden haag\b|\bgroningen\b|\bmaastricht\b|\bdelft\b|\bleiden\b|\bhaarlem\b|\bbreda\b|\bnijmegen\b|\bzwolle\b|\barnhem\b|\balkmaar\b|\bamersfoort\b|\bhertogenbosch\b|\benschede\b|\bapeldoorn\b|\balmere\b/i;
const CH_HINT =
  /\bswitzerland\b|\bschweiz\b|\bsuisse\b|\bsvizzera\b|\bzurich\b|\bzuerich\b|\bz\xfcrich\b|\bgeneva\b|\bgeneve\b|\bgen\xe8ve\b|\bbasel\b|\bbasle\b|\bbern\b|\bberne\b|\blausanne\b|\blugano\b|\bluzern\b|\blucerne\b|\bst\.?\s*gallen\b|\bwinterthur\b|\bzug\b|\bfribourg\b|\bneuchatel\b|\bneuch\xe2tel\b|\bsion\b|\bsitten\b|\bbiel\b|\bbienne\b|\bthun\b|\bschaffhausen\b|\bchur\b|\bcoire\b/i;

function printHelp() {
  console.log(`Discover employer job-board candidates via the Common Crawl index.

Usage:
  node scripts/discover-boards.mjs [options]

Options:
  --help               Show this help and exit.
  --crawls <n>         Newest N crawls from collinfo.json to read (default ${DEFAULTS.crawls}).
  --crawl <id>         Use a specific crawl id (repeatable; overrides --crawls).
  --platform <name>    Only this board system (repeatable; default all).
                       greenhouse, ashby, lever, recruitee, personio, teamtailor,
                       workable
  --output <path>      CSV destination (default scripts/output/discovered-boards.csv).
  --max-pages <n>      Index pages fetched per pattern per crawl (default ${DEFAULTS.maxPages}).
  --max-verify <n>     Verify at most N candidates per platform, 0 = all (default ${DEFAULTS.maxVerify}).
  --delay-ms <n>       Minimum gap between request starts, shared across all
                       requests (default ${DEFAULTS.delayMs}).
  --timeout-ms <n>     Per-request timeout (default ${DEFAULTS.timeoutMs}).
  --index-only         List candidates without verifying feeds (no CSV postings columns).
  --include-known      Keep boards already listed in lib/ats-feeds.ts (default: excluded).
  --candidate <p:s>    Verify an explicit board (repeatable, skips the index).
                       Example: --candidate greenhouse:adyen --candidate ashby:mollie

The run writes the survivors to the CSV with columns:
  platform, slug, suggested name, country, postings in NL/CH, example job URL.
It prints a summary (candidates per platform, verified, rejected and why) and touches
only the CSV, which defaults inside scripts/output/ and follows --output
wherever it is pointed. The CSV is leads for a human to verify, not an employer list.

Known limit: Common Crawl does not crawl jobs.lever.co, so expect near-zero Lever
candidates from this route.`);
}

function parseArgs(argv) {
  const options = {
    crawls: DEFAULTS.crawls,
    crawlIds: [],
    platforms: new Set(),
    output: DEFAULTS.output,
    maxPages: DEFAULTS.maxPages,
    maxVerify: DEFAULTS.maxVerify,
    delayMs: DEFAULTS.delayMs,
    timeoutMs: DEFAULTS.timeoutMs,
    indexOnly: false,
    includeKnown: false,
    candidates: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}.`);
      i += 1;
      return value;
    };
    const nextInt = () => {
      const value = Number(next());
      if (!Number.isInteger(value) || value < 0) throw new Error(`${arg} needs a non-negative integer.`);
      return value;
    };
    if (arg === '--help') return { help: true, options };
    else if (arg === '--crawls') options.crawls = nextInt();
    else if (arg === '--crawl') options.crawlIds.push(next());
    else if (arg === '--platform') options.platforms.add(next().toLowerCase());
    else if (arg === '--output') options.output = resolve(process.cwd(), next());
    else if (arg === '--max-pages') options.maxPages = nextInt();
    else if (arg === '--max-verify') options.maxVerify = nextInt();
    else if (arg === '--delay-ms') options.delayMs = nextInt();
    else if (arg === '--timeout-ms') options.timeoutMs = nextInt();
    else if (arg === '--index-only') options.indexOnly = true;
    else if (arg === '--include-known') options.includeKnown = true;
    else if (arg === '--candidate') {
      const value = next().toLowerCase();
      const separator = value.indexOf(':');
      if (separator < 1) throw new Error(`--candidate needs platform:slug, got ${value}.`);
      options.candidates.push({ platform: value.slice(0, separator), slug: value.slice(separator + 1) });
    }
    else throw new Error(`Unknown argument ${arg}. Use --help.`);
  }
  return { help: false, options };
}

const sleep = (ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });

/** One-line network error description, including the underlying cause when present. */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause
    ? (error.cause.message ?? String(error.cause)) : '';
  return cause && !message.includes(cause) ? `${message} (${cause})` : message;
}

/**
 * A pause before a request starts, shared by every caller.
 *
 * The old arrangement slept *after* each item inside each worker, which is not the same thing:
 * with four workers, the first four requests still left together in the same instant, and only
 * the fifth onwards was paced. Against an index that asks for no parallel threads, the opening
 * burst is exactly the part that matters. Holding the next start time in one place means the
 * spacing is real no matter how many callers there are.
 */
let nextAllowedStart = 0;

/** Test seam: the pacer holds process-wide state, so a test must be able to reset it. */
export function resetPacing() {
  nextAllowedStart = 0;
}

/**
 * The pacing applied to Common Crawl index requests, set once the options are known.
 *
 * Module state rather than a threaded parameter because the pacing is a property of the
 * service being called, not of any one call site, and every index request must share it.
 */
let indexDelayMs = DEFAULTS.delayMs;

export async function paceStart(delayMs) {
  if (!(delayMs > 0)) return;
  const now = Date.now();
  const start = Math.max(now, nextAllowedStart);
  nextAllowedStart = start + delayMs;
  if (start > now) await sleep(start - now);
}

/** Runs fn over items with at most `limit` in flight and a pause between starts. */
async function mapWithConcurrency(items, limit, fn, delayMs = 0) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        results[index] = { error: error instanceof Error ? error.message : String(error) };
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
  return results;
}

/**
 * One request, with the timeout covering the whole exchange.
 *
 * Clearing the timer as soon as `fetch()` resolved only ever guarded the headers: a server that
 * sends a status line and then stalls mid-body would hang the run indefinitely, which is the one
 * failure a timeout exists to prevent. The body is read here, under the same signal, and the
 * timer is cleared only once there is nothing left to wait for. `lib/ats-feeds.ts` already does
 * this; the script was the odd one out.
 */
async function politeFetch(url, { timeoutMs, accept } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULTS.timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: accept ?? '*/*' },
      signal: controller.signal,
    });
    const body = response.ok ? await response.text() : '';
    return { response, body, ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Common Crawl index answers 429/503 when probed too fast. Retry those a few times with
 * growing pauses instead of recording a failure at the first busy signal; other statuses and
 * employer feeds keep single-attempt semantics via politeFetch.
 */
function retryAfterMs(response) {
  const header = response?.headers?.get?.('retry-after');
  if (!header) return 0;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(60_000, seconds * 1000));
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, Math.min(60_000, when - Date.now())) : 0;
}

async function fetchWithRetry(url, { timeoutMs, accept, delayMs = 0 } = {}, attempts = 4) {
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await paceStart(delayMs);
    result = await politeFetch(url, { timeoutMs, accept });
    if (result.status !== 429 && result.status !== 503) return result;
    if (attempt < attempts) {
      // When the server says how long to wait, that number wins over our own guess. Backing off
      // for less than we were asked to is the part that turns a busy signal into a complaint.
      const asked = retryAfterMs(result.response);
      await sleep(Math.max(asked, 2000 * attempt));
    }
  }
  return result;
}

async function newestCrawlIds(count) {
  let response;
  try {
    response = await fetchWithRetry('https://index.commoncrawl.org/collinfo.json', {
      accept: 'application/json', delayMs: indexDelayMs,
    });
  } catch (error) {
    throw new Error(`collinfo.json unreachable (${describeError(error)}).`);
  }
  if (!response.ok) throw new Error(`collinfo.json answered HTTP ${response.status}.`);
  const list = JSON.parse(response.body);
  if (!Array.isArray(list) || list.length === 0) throw new Error('collinfo.json held no crawls.');
  // collinfo.json is ordered newest first; the first entries are the newest crawls.
  return list.slice(0, Math.max(1, count)).map((entry) => String(entry.id));
}

/** CDX query form of a pattern: the index needs a path part, so append /* when missing. */
function queryPattern(pattern) {
  return pattern.endsWith('/*') ? pattern : `${pattern}/*`;
}

async function indexPageCount(crawlId, pattern) {
  const url =
    `https://index.commoncrawl.org/${crawlId}-index` +
    `?url=${encodeURIComponent(queryPattern(pattern))}&output=json&fl=url&collapse=urlkey&showNumPages=true`;
  const response = await fetchWithRetry(url, { accept: 'application/json', delayMs: indexDelayMs });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Number(JSON.parse(response.body).pages ?? 0);
}

async function indexPage(crawlId, pattern, page) {
  const url =
    `https://index.commoncrawl.org/${crawlId}-index` +
    `?url=${encodeURIComponent(queryPattern(pattern))}&output=json&fl=url&collapse=urlkey&page=${page}`;
  const response = await fetchWithRetry(url, { accept: 'application/json', delayMs: indexDelayMs });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = response.body;
  const urls = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.url) urls.push(String(parsed.url));
    } catch {
      // One malformed line never stops the page.
    }
  }
  return urls;
}

/** Company identifier out of a captured URL, or '' when the URL carries none. */
export function slugFromUrl(platform, rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return '';
  }
  const host = parsed.hostname.toLowerCase();
  if (platform === 'greenhouse') {
    if (host !== 'boards.greenhouse.io' && host !== 'job-boards.greenhouse.io') return '';
    const segment = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    return /^[a-z0-9][a-z0-9_-]*$/i.test(segment) ? segment.toLowerCase() : '';
  }
  if (platform === 'ashby') {
    if (host !== 'jobs.ashbyhq.com') return '';
    const segment = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    return /^[a-z0-9][a-z0-9_-]*$/i.test(segment) ? segment.toLowerCase() : '';
  }
  if (platform === 'lever') {
    if (host !== 'jobs.lever.co') return '';
    const segment = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    return /^[a-z0-9][a-z0-9_-]*$/i.test(segment) ? segment.toLowerCase() : '';
  }
  if (platform === 'recruitee') {
    const match = host.match(/^([a-z0-9][a-z0-9-]*)\.recruitee\.com$/);
    return match ? match[1] : '';
  }
  if (platform === 'personio') {
    const match = host.match(/^([a-z0-9][a-z0-9-]*)\.jobs\.personio\.de$/);
    return match ? match[1] : '';
  }
  if (platform === 'teamtailor') {
    const match = host.match(/^([a-z0-9][a-z0-9-]*)\.teamtailor\.com$/);
    return match ? match[1] : '';
  }
  if (platform === 'workable') {
    if (host !== 'apply.workable.com') return '';
    const segment = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    // apply.workable.com/<account>/j/<shortcode>/ - the account is the first segment, but the
    // host also serves /api and /j paths that are not accounts.
    if (segment === 'api' || segment === 'j') return '';
    return /^[a-z0-9][a-z0-9_-]*$/i.test(segment) ? segment.toLowerCase() : '';
  }
  return '';
}

/** Feed URL shapes, mirroring lib/ats-feeds.ts feedUrl for the discovered platforms. */
export function feedUrlFor(platform, slug) {
  if (platform === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  if (platform === 'lever') return `https://api.lever.co/v0/postings/${slug}?mode=json`;
  if (platform === 'recruitee') return `https://${slug}.recruitee.com/api/offers/`;
  if (platform === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
  if (platform === 'personio') return `https://${slug}.jobs.personio.de/xml`;
  if (platform === 'teamtailor') return `https://${slug}.teamtailor.com/jobs.json`;
  if (platform === 'workable') return `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`;
  throw new Error(`Unknown platform ${platform}.`);
}

function stripToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagText(block, tag) {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return '';
  return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

/**
 * Minimal per-platform parsing: only what verification needs (location, text length, job URL).
 * Shapes mirror lib/ats-feeds.ts parseFeed; anything unparseable counts as no postings.
 */
export function postingsFromFeed(platform, body) {
  if (platform === 'personio') {
    const postings = [];
    for (const match of body.matchAll(/<position>([\s\S]*?)<\/position>/gi)) {
      const block = match[1];
      const id = tagText(block, 'id');
      const descriptions = [...block.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/gi)]
        .map((entry) => `${tagText(entry[1], 'name')} ${tagText(entry[1], 'value')}`).join(' ');
      const text = stripToText(descriptions);
      if (!text) continue;
      postings.push({ location: tagText(block, 'office'), textLength: text.length, url: '', positionId: id });
    }
    return postings;
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('feed-parse-error');
  }
  if (platform === 'teamtailor') {
    const items = payload.items ?? [];
    return items.flatMap((item) => {
      const text = stripToText(item.content_html ?? '');
      if (!String(item.url ?? '').trim() || !text) return [];
      const posting = item._jobposting ?? {};
      const raw = posting.jobLocation;
      const places = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const location = places
        .map((place) => {
          const address = place.address ?? {};
          const code = String(address.addressCountry ?? '').toUpperCase();
          const country = code === 'NL' ? 'Netherlands' : code === 'CH' ? 'Switzerland' : code;
          return [address.addressLocality, country || address.addressRegion].filter(Boolean).join(', ');
        })
        .join('; ');
      return [{ location, textLength: text.length, url: String(item.url) }];
    });
  }
  if (platform === 'workable') {
    // Country arrives spelled out, so city and country read like every other board's location.
    return (payload.jobs ?? []).flatMap((job) => {
      const text = stripToText(job.description ?? '');
      const url = String(job.url ?? job.shortlink ?? job.application_url ?? '');
      if (!url || !text) return [];
      return [{
        location: [job.city, job.country].map((part) => String(part ?? '').trim()).filter(Boolean).join(', '),
        textLength: text.length,
        url,
      }];
    });
  }
  const rows = Array.isArray(payload) ? payload : payload.jobs ?? payload.offers ?? [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    if (platform === 'greenhouse') {
      const text = stripToText(row.content ?? '');
      if (!row.absolute_url || !text) return [];
      return [{ location: row.location?.name ?? '', textLength: text.length, url: String(row.absolute_url) }];
    }
    if (platform === 'ashby') {
      const text = stripToText(row.descriptionHtml ?? row.descriptionPlain ?? '');
      if (!row.jobUrl || !text) return [];
      return [{ location: String(row.location ?? ''), textLength: text.length, url: String(row.jobUrl) }];
    }
    if (platform === 'lever') {
      const text = stripToText(row.description ?? row.descriptionPlain ?? '');
      if (!row.hostedUrl || !text) return [];
      return [{ location: String(row.categories?.location ?? ''), textLength: text.length, url: String(row.hostedUrl) }];
    }
    // recruitee
    const text = stripToText(`${row.description ?? ''} ${row.requirements ?? ''}`);
    const url = String(row.careers_url ?? row.careers_apply_url ?? '');
    if (!url || !text) return [];
    return [{
      location: [row.city, row.country].filter(Boolean).join(', '),
      textLength: text.length,
      url,
    }];
  });
}

export function countryHint(location) {
  const value = String(location ?? '');
  if (CH_HINT.test(value)) return 'switzerland';
  if (NL_HINT.test(value)) return 'netherlands';
  return '';
}

export function humanizeSlug(slug) {
  return slug.split(/[-_]+/).filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ') || slug;
}

/** Slugs already configured, read best-effort from lib/ats-feeds.ts (never fails the run). */
async function knownBoards() {
  try {
    const source = await readFile(resolve(projectRoot, 'lib', 'ats-feeds.ts'), 'utf8');
    const known = new Set();
    // Entries are single-line `{ slug: 'x', name: '...', platform: 'y', ... }`; read the
    // platform on the same line so the key is platform-scoped, not slug-global.
    for (const line of source.split('\n')) {
      const slugMatch = line.match(/slug:\s*'([^']+)'/);
      const platformMatch = line.match(/platform:\s*'([a-z]+)'/);
      if (slugMatch && platformMatch) known.add(`${platformMatch[1]}:${slugMatch[1].toLowerCase()}`);
    }
    return known;
  } catch {
    return new Set();
  }
}

async function verifyBoard(platform, slug, timeoutMs) {
  let result;
  try {
    result = await politeFetch(feedUrlFor(platform, slug), {
      timeoutMs,
      accept: 'application/json, application/xml',
    });
  } catch (error) {
    return { kept: false, reason: error?.name === 'AbortError' ? 'feed-timeout' : 'feed-network-error' };
  }
  if (!result.ok) return { kept: false, reason: `feed-http-${result.status}` };
  const body = result.body;
  let postings;
  try {
    postings = postingsFromFeed(platform, body);
    if (platform === 'personio') {
      postings = postings.map((posting) => ({
        ...posting,
        url: posting.positionId ? `https://${slug}.jobs.personio.de/job/${posting.positionId}` : '',
      }));
    }
  } catch {
    return { kept: false, reason: 'feed-parse-error' };
  }
  if (postings.length === 0) return { kept: false, reason: 'no-postings' };
  const matching = postings.filter(
    (posting) => countryHint(posting.location) !== '' && posting.textLength >= 900,
  );
  if (matching.length === 0) {
    const anyLocal = postings.some((posting) => countryHint(posting.location) !== '');
    return { kept: false, reason: anyLocal ? 'no-long-nl-ch-posting' : 'no-nl-ch-posting' };
  }
  const countries = new Set(matching.map((posting) => countryHint(posting.location)));
  return {
    kept: true,
    country: countries.has('switzerland') && countries.has('netherlands')
      ? 'both'
      : countries.has('switzerland') ? 'switzerland' : 'netherlands',
    count: matching.length,
    exampleUrl: matching[0].url,
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function printIndexWarnings(indexFailures) {
  if (indexFailures.length === 0) return;
  console.log(`Index warnings (${indexFailures.length}):`);
  for (const warning of indexFailures.slice(0, 10)) console.log(`  ${warning}`);
  if (indexFailures.length > 10) console.log(`  ...and ${indexFailures.length - 10} more`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  indexDelayMs = parsed.delayMs ?? DEFAULTS.delayMs;
  if (parsed.help) {
    printHelp();
    return;
  }
  const options = parsed.options;

  const patterns = PATTERNS.filter(
    (entry) => options.platforms.size === 0 || options.platforms.has(entry.platform),
  );
  if (patterns.length === 0) throw new Error('No board system matches --platform.');
  const known = options.includeKnown ? new Set() : await knownBoards();
  let skippedKnown = 0;

  const candidates = new Map(); // "platform:slug" -> { platform, slug}
  const indexFailures = [];
  if (options.candidates.length > 0) {
    // Explicit boards skip the index entirely; useful for smoke tests and hand-found leads.
    const validPlatforms = new Set(PATTERNS.map((entry) => entry.platform));
    for (const { platform, slug } of options.candidates) {
      if (!validPlatforms.has(platform)) throw new Error(`Unknown platform in --candidate: ${platform}.`);
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new Error(`Bad slug in --candidate: ${slug}.`);
      candidates.set(`${platform}:${slug}`, { platform, slug });
    }
    console.log(`Crawls: skipped (--candidate given)`);
  } else {
    const crawlIds = options.crawlIds.length > 0 ? options.crawlIds : await newestCrawlIds(options.crawls);
    console.log(`Crawls: ${crawlIds.join(', ')}`);

    // 1. Candidates from the index, one request at a time.
    //
    // Common Crawl asks that the index not be queried with parallel threads, and it is a single
    // shared service rather than a collection of separate employers' servers, so concurrency here
    // is load on one host. Verification below stays at four in flight because those requests go
    // to many different employers, one each.
    const patternJobs = [];
    for (const { platform, pattern } of patterns) {
      for (const crawlId of crawlIds) {
        patternJobs.push({ platform, pattern, crawlId });
      }
    }
    await mapWithConcurrency(patternJobs, 1, async ({ platform, pattern, crawlId }) => {
      let pages = 0;
      try {
        pages = await indexPageCount(crawlId, pattern);
      } catch (error) {
        indexFailures.push(`${crawlId} ${pattern}: page count failed (${describeError(error)})`);
        return;
      }
      const wanted = Math.min(pages, options.maxPages);
      for (let page = 0; page < wanted; page += 1) {
        let urls;
        try {
          urls = await indexPage(crawlId, pattern, page);
        } catch (error) {
          indexFailures.push(`${crawlId} ${pattern} page ${page}: fetch failed (${describeError(error)})`);
          continue;
        }
        for (const url of urls) {
          const slug = slugFromUrl(platform, url);
          if (!slug) continue;
          const key = `${platform}:${slug}`;
          if (!candidates.has(key)) candidates.set(key, { platform, slug });
        }
        if (options.delayMs > 0) await sleep(options.delayMs);
      }
    }, options.delayMs);
  }

  const perPlatform = new Map();
  for (const { platform, slug } of candidates.values()) {
    if (!known.has(`${platform}:${slug}`)) {
      if (!perPlatform.has(platform)) perPlatform.set(platform, []);
      perPlatform.get(platform).push(slug);
    } else {
      skippedKnown += 1;
    }
  }
  for (const slugs of perPlatform.values()) slugs.sort();

  const foundCounts = Object.fromEntries(
    [...perPlatform.entries()].map(([platform, slugs]) => [platform, slugs.length]),
  );
  console.log(`Candidates: ${candidates.size} unique boards`
    + (skippedKnown > 0 ? ` (${skippedKnown} already configured, excluded)` : ''));
  for (const platform of [...new Set(patterns.map((entry) => entry.platform))]) {
    if (foundCounts[platform] !== undefined) console.log(`  ${platform}: ${foundCounts[platform]} candidates`);
  }
  if (options.candidates.length === 0
    && patterns.some((entry) => entry.platform === 'lever') && (foundCounts.lever ?? 0) === 0) {
    console.log('  lever: 0 candidates — expected: Common Crawl does not crawl jobs.lever.co.');
  }

  if (options.indexOnly) {
    console.log('Index-only run: feeds not verified, no CSV written.');
    printIndexWarnings(indexFailures);
    return;
  }

  // 2. Verify each candidate against its own public feed.
  const survivors = [];
  const rejected = {}; // reason -> count
  const verifyJobs = [];
  for (const [platform, slugs] of perPlatform) {
    const limited = options.maxVerify > 0 ? slugs.slice(0, options.maxVerify) : slugs;
    if (limited.length < slugs.length) {
      console.log(`  ${platform}: verifying first ${limited.length} of ${slugs.length} (--max-verify ${options.maxVerify})`);
    }
    for (const slug of limited) verifyJobs.push({ platform, slug });
  }
  let done = 0;
  await mapWithConcurrency(verifyJobs, 4, async ({ platform, slug }) => {
    const result = await verifyBoard(platform, slug, options.timeoutMs);
    done += 1;
    if (done % 50 === 0 || done === verifyJobs.length) {
      console.log(`  verified ${done}/${verifyJobs.length}...`);
    }
    if (result.kept) {
      survivors.push({
        platform,
        slug,
        name: humanizeSlug(slug),
        country: result.country,
        count: result.count,
        exampleUrl: result.exampleUrl,
      });
    } else {
      rejected[result.reason] = (rejected[result.reason] ?? 0) + 1;
    }
  }, options.delayMs);

  survivors.sort((a, b) => a.platform.localeCompare(b.platform) || a.slug.localeCompare(b.slug));
  const header = 'platform,slug,suggested name,country,postings in NL/CH,example job URL';
  const csv = [header, ...survivors.map((row) =>
    [row.platform, row.slug, row.name, row.country, row.count, row.exampleUrl].map(csvCell).join(','))].join('\n')
    + '\n';
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, csv, 'utf8');

  console.log(`\nVerified: ${survivors.length} kept, ${verifyJobs.length - survivors.length} rejected.`);
  console.log(`Rejected: ${Object.entries(rejected).map(([reason, count]) => `${reason} ${count}`).join(', ') || 'none'}`);
  printIndexWarnings(indexFailures);
  console.log(`CSV: ${options.output} (${survivors.length} leads for human review)`);
}

try {
  // Importing this module (e.g. to unit-test the pure helpers) must not start a run.
  const invokedDirectly = process.argv[1]
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  if (invokedDirectly) await main();
} catch (error) {
  console.error(`discover-boards: ${describeError(error)}`);
  process.exit(1);
}
