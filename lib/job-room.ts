import type { StructuredLanguageSkill } from './analysis';
import { delay, type ParsedJob } from './jobsch';

const SEARCH_ENDPOINT = 'https://www.job-room.ch/jobadservice/api/jobAdvertisements/_search';
const DETAIL_ENDPOINT = 'https://www.job-room.ch/jobadservice/api/jobAdvertisements';
const PUBLIC_JOB_URL = 'https://www.job-room.ch/job-search';
const PAGE_SIZE = 100;
const ONLINE_SINCE_DAYS = 30;

/**
 * Below this, a description is a preview rather than an advertisement and is not worth screening.
 * Measured on the stored corpus: Job-Room previews have a median length of 277 characters, while a
 * real advertisement runs to a few thousand.
 */
export const JOB_ROOM_FULL_TEXT_THRESHOLD = 900;
/** Detail requests are one-per-job, so they are capped and paced like every other fetching source. */
export const MAX_JOB_ROOM_DETAIL_FETCHES = 120;
export const JOB_ROOM_DETAIL_DELAY_MS = 400;

/** Job-Room returns whole advertisements in the search response, so a run costs a few requests instead of one per job. */
export const MAX_PAGES_PER_TERM = 2;

interface JobRoomDescription {
  languageIsoCode?: string;
  title?: string;
  description?: string;
}

interface JobRoomAdvertisement {
  id?: string;
  /**
   * The publication window, and the reason every stored Job-Room row had no posting date.
   *
   * The parser read `publicationStartDate` at the top level. There is no such field: the live
   * response nests it as `publication.startDate`, so the optional chain resolved to undefined and
   * every advertisement was stored dateless - 193 of 193 in the development database, while every
   * other source was at 0% missing. A dateless row cannot be told apart from a fresh one, which is
   * how a posting from four weeks ago arrives looking like today's.
   *
   * `endDate` is the other half: it is published and was being ignored, so advertisements whose
   * window had closed were imported as new and linked to a page saying "no longer active".
   */
  publication?: { startDate?: string; endDate?: string };
  /** CANCELLED / REJECTED and the rest; anything but an active status is not worth importing. */
  status?: string;
  cancellationDate?: string;
  jobContent?: {
    externalUrl?: string | null;
    jobDescriptions?: JobRoomDescription[];
    company?: { name?: string };
    location?: { city?: string; postalCode?: string; cantonCode?: string; countryIsoCode?: string };
    languageSkills?: StructuredLanguageSkill[];
  };
}

export interface JobRoomParsedJob extends ParsedJob {
  languageSkills: StructuredLanguageSkill[];
}

/** Search highlighting wraps matched terms in <em>; strip it so titles stay clean. */
function cleanTitle(value: string) {
  return value.replace(/<\/?em>/gi, '').replace(/\s+/g, ' ').trim();
}

function preferredDescription(descriptions: JobRoomDescription[]) {
  return descriptions.find((entry) => entry.languageIsoCode === 'en')
    ?? descriptions.find((entry) => (entry.description ?? '').trim())
    ?? descriptions[0];
}

/**
 * Whether the advertisement is still open on the day it is read.
 *
 * Exported so the rule is testable without a network call. A missing end date means the
 * advertisement carries no expiry, which is not the same as being expired - those are kept.
 */
export function isPublicationOpen(advertisement: JobRoomAdvertisement, today = new Date()): boolean {
  if (advertisement.cancellationDate) return false;
  const status = (advertisement.status ?? '').toUpperCase();
  if (status && status !== 'PUBLISHED_PUBLIC' && status !== 'PUBLISHED_RESTRICTED' && status !== 'ACTIVE') return false;
  const end = advertisement.publication?.endDate;
  if (!end) return true;
  // Date-only strings compare correctly as ISO text, and the end date is inclusive: an
  // advertisement is still open on the day it closes.
  return end >= today.toISOString().slice(0, 10);
}

export function advertisementToParsedJob(advertisement: JobRoomAdvertisement): JobRoomParsedJob | null {
  const content = advertisement.jobContent;
  if (!advertisement.id || !content) return null;
  // An advertisement that has closed is not a new job. It was being imported as one, and its
  // link led to a page saying the posting is no longer active.
  if (!isPublicationOpen(advertisement)) return null;
  const description = preferredDescription(content.jobDescriptions ?? []);
  const title = cleanTitle(description?.title ?? '');
  const body = (description?.description ?? '').trim();
  if (!title || !body) return null;
  const location = [content.location?.city, content.location?.postalCode, content.location?.cantonCode]
    .filter(Boolean).join(' ') || 'Switzerland';
  return {
    sourceUrl: `${PUBLIC_JOB_URL}/${advertisement.id}`,
    title,
    company: content.company?.name ?? '',
    location,
    descriptionHtml: body,
    postedAt: advertisement.publication?.startDate ?? '',
    languageSkills: content.languageSkills ?? [],
  };
}

async function searchPage(term: string, page: number): Promise<JobRoomAdvertisement[]> {
  const url = `${SEARCH_ENDPOINT}?page=${page}&size=${PAGE_SIZE}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      permanent: null,
      workloadPercentageMin: 0,
      workloadPercentageMax: 100,
      onlineSince: ONLINE_SINCE_DAYS,
      displayRestricted: false,
      keywords: term.trim() ? [term.trim()] : [],
    }),
  });
  if (!response.ok) throw new Error(`Job-Room request failed (${response.status}).`);
  const payload = await response.json() as { jobAdvertisement?: JobRoomAdvertisement }[];
  return Array.isArray(payload) ? payload.map((entry) => entry.jobAdvertisement).filter(Boolean) as JobRoomAdvertisement[] : [];
}

/**
 * Fetch one advertisement in full.
 *
 * The search endpoint returns a preview, not the advertisement: measured against the live API, a
 * result carried 316 characters where the detail endpoint for the same id returned 4,193 — thirteen
 * times as much. That gap is the whole problem with screening this source. A language requirement
 * sits in the "Ihr Profil" section near the end of an ad, so on a 316-character preview the filter
 * was reporting "no requirement found" when it had simply never been shown the part that has one.
 *
 * Same public API, same terms, no key, one GET. Returns null on any failure so a single bad
 * advertisement leaves the preview in place rather than failing the batch.
 */
export async function fetchJobRoomDetail(id: string): Promise<JobRoomParsedJob | null> {
  try {
    const response = await fetch(`${DETAIL_ENDPOINT}/${encodeURIComponent(id)}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const payload = await response.json() as { jobAdvertisement?: JobRoomAdvertisement } & JobRoomAdvertisement;
    return advertisementToParsedJob(payload.jobAdvertisement ?? payload);
  } catch {
    return null;
  }
}

export function jobRoomIdFromUrl(sourceUrl: string) {
  return sourceUrl.startsWith(`${PUBLIC_JOB_URL}/`)
    ? sourceUrl.slice(PUBLIC_JOB_URL.length + 1).split(/[?#/]/)[0]
    : '';
}

/**
 * One request per term/page returns up to 100 advertisement previews, deduplicated by id, then one
 * request each to replace the preview with the full text.
 *
 * The detail pass is what makes this source screenable, so it is not optional, but it is the only
 * place in the app that issues a request per job. It is therefore paced by the same delay every
 * other source uses, capped, and degrades to the preview rather than failing.
 */
export async function searchJobRoom(
  terms: string[],
  pagesPerTerm = MAX_PAGES_PER_TERM,
  { fullText = true, maxDetails = MAX_JOB_ROOM_DETAIL_FETCHES, delayMs = JOB_ROOM_DETAIL_DELAY_MS } = {},
): Promise<JobRoomParsedJob[]> {
  const queries = terms.length ? terms : [''];
  const byUrl = new Map<string, JobRoomParsedJob>();
  for (const term of queries) {
    for (let page = 0; page < pagesPerTerm; page += 1) {
      const advertisements = await searchPage(term, page);
      for (const advertisement of advertisements) {
        const parsed = advertisementToParsedJob(advertisement);
        if (parsed && !byUrl.has(parsed.sourceUrl)) byUrl.set(parsed.sourceUrl, parsed);
      }
      if (advertisements.length < PAGE_SIZE) break;
    }
  }

  const previews = [...byUrl.values()];
  if (!fullText) return previews;

  // Only ads that actually look truncated are worth a second request; some already arrive whole.
  const needsDetail = previews
    .filter((job) => job.descriptionHtml.length < JOB_ROOM_FULL_TEXT_THRESHOLD)
    .slice(0, maxDetails);
  for (const [index, job] of needsDetail.entries()) {
    if (index > 0) await delay(delayMs);
    const id = jobRoomIdFromUrl(job.sourceUrl);
    const detail = id ? await fetchJobRoomDetail(id) : null;
    // Keep the fuller of the two: a detail response is normally longer, but never assume it.
    if (detail && detail.descriptionHtml.length > job.descriptionHtml.length) {
      byUrl.set(job.sourceUrl, { ...job, ...detail, sourceUrl: job.sourceUrl });
    }
  }
  return [...byUrl.values()];
}
