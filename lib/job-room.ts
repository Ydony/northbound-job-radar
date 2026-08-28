import type { StructuredLanguageSkill } from './analysis';
import type { ParsedJob } from './jobsch';

const SEARCH_ENDPOINT = 'https://www.job-room.ch/jobadservice/api/jobAdvertisements/_search';
const PUBLIC_JOB_URL = 'https://www.job-room.ch/job-search';
const PAGE_SIZE = 100;
const ONLINE_SINCE_DAYS = 30;

/** Job-Room returns whole advertisements in the search response, so a run costs a few requests instead of one per job. */
export const MAX_PAGES_PER_TERM = 2;

interface JobRoomDescription {
  languageIsoCode?: string;
  title?: string;
  description?: string;
}

interface JobRoomAdvertisement {
  id?: string;
  publicationStartDate?: string;
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

export function advertisementToParsedJob(advertisement: JobRoomAdvertisement): JobRoomParsedJob | null {
  const content = advertisement.jobContent;
  if (!advertisement.id || !content) return null;
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
    postedAt: advertisement.publicationStartDate ?? '',
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

/** One request per term/page returns up to 100 complete advertisements, deduplicated by advertisement id. */
export async function searchJobRoom(terms: string[], pagesPerTerm = MAX_PAGES_PER_TERM): Promise<JobRoomParsedJob[]> {
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
  return [...byUrl.values()];
}
