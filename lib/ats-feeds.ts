import type { ParsedJob } from './jobsch';
import type { JobCountry } from './types';

/**
 * Public ATS job boards. These endpoints exist so aggregators and job boards can read a company's
 * openings, so they need no key, no VPN, and carry no terms conflict - unlike the page-fetching
 * sources. Employers carry the volume here; staffing agencies publish only their own internal
 * hiring to these boards, which is why the list is mostly direct employers.
 *
 * Every entry below was verified live before being added. To add a company, find its slug and
 * confirm one of the platform URLs returns postings, then append it here.
 */
export type AtsPlatform = 'greenhouse' | 'lever' | 'recruitee' | 'ashby' | 'personio';

export interface AtsCompany {
  slug: string;
  name: string;
  platform: AtsPlatform;
  country: Exclude<JobCountry, 'unknown'>;
}

export const atsCompanies: AtsCompany[] = [
  // Netherlands
  { slug: 'adyen', name: 'Adyen', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'dept', name: 'DEPT', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'bloomreach', name: 'Bloomreach', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'catawiki', name: 'Catawiki', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'flowtraders', name: 'Flow Traders', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'fourthline', name: 'Fourthline', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'octagon', name: 'Octagon Professionals', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'mollie', name: 'Mollie', platform: 'ashby', country: 'netherlands' },
  { slug: 'bynder', name: 'Bynder', platform: 'ashby', country: 'netherlands' },
  { slug: 'bunq', name: 'bunq', platform: 'recruitee', country: 'netherlands' },
  { slug: 'channable', name: 'Channable', platform: 'recruitee', country: 'netherlands' },
  { slug: 'vandebron', name: 'Vandebron', platform: 'recruitee', country: 'netherlands' },
  { slug: 'nmbrs', name: 'Nmbrs', platform: 'recruitee', country: 'netherlands' },
  { slug: 'adecco', name: 'Adecco', platform: 'recruitee', country: 'netherlands' },
  { slug: 'ohpen', name: 'Ohpen', platform: 'personio', country: 'netherlands' },
  { slug: 'randstad', name: 'Randstad', platform: 'personio', country: 'netherlands' },
  { slug: 'framer', name: 'Framer', platform: 'personio', country: 'netherlands' },
  // Switzerland
  { slug: 'onrunning', name: 'On', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'proton', name: 'Proton', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'scandit', name: 'Scandit', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'frontify', name: 'Frontify', platform: 'ashby', country: 'switzerland' },
  { slug: 'smallpdf', name: 'Smallpdf', platform: 'ashby', country: 'switzerland' },
  { slug: 'climeworks', name: 'Climeworks', platform: 'recruitee', country: 'switzerland' },
  { slug: 'elca', name: 'ELCA', platform: 'recruitee', country: 'switzerland' },
  { slug: 'sika', name: 'Sika', platform: 'personio', country: 'switzerland' },
  { slug: 'swisslinx', name: 'Swisslinx', platform: 'personio', country: 'switzerland' },
];

export function feedUrl(company: AtsCompany) {
  switch (company.platform) {
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs?content=true`;
    case 'lever': return `https://api.lever.co/v0/postings/${company.slug}?mode=json`;
    case 'recruitee': return `https://${company.slug}.recruitee.com/api/offers/`;
    case 'ashby': return `https://api.ashbyhq.com/posting-api/job-board/${company.slug}`;
    case 'personio': return `https://${company.slug}.jobs.personio.de/xml`;
  }
}

function decodeEntities(value: string) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function tagText(block: string, tag: string) {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? decodeEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : '';
}

/** Each platform publishes a different shape; normalize them all to ParsedJob. */
export function parseFeed(company: AtsCompany, body: string): ParsedJob[] {
  const fallback = company.country === 'switzerland' ? 'Switzerland' : 'Netherlands';
  if (company.platform === 'personio') {
    return [...body.matchAll(/<position>([\s\S]*?)<\/position>/gi)].map((match) => {
      const block = match[1];
      const id = tagText(block, 'id');
      const descriptions = [...block.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/gi)]
        .map((entry) => `${tagText(entry[1], 'name')} ${tagText(entry[1], 'value')}`).join(' ');
      return {
        sourceUrl: `https://${company.slug}.jobs.personio.de/job/${id}`,
        title: tagText(block, 'name'),
        company: company.name,
        location: tagText(block, 'office') || fallback,
        descriptionHtml: descriptions,
        postedAt: tagText(block, 'createdAt'),
      };
    }).filter((job) => job.title && job.descriptionHtml.trim());
  }

  const payload: unknown = JSON.parse(body);
  const rows = Array.isArray(payload) ? payload
    : (payload as { jobs?: unknown[]; offers?: unknown[] }).jobs
    ?? (payload as { offers?: unknown[] }).offers
    ?? [];

  return (rows as Record<string, never>[]).map((row): ParsedJob | null => {
    const get = (key: string) => (row as Record<string, unknown>)[key];
    if (company.platform === 'greenhouse') {
      const content = String(get('content') ?? '');
      return {
        sourceUrl: String(get('absolute_url') ?? ''),
        title: String(get('title') ?? ''),
        company: company.name,
        location: (get('location') as { name?: string })?.name || fallback,
        descriptionHtml: decodeEntities(content),
        postedAt: String(get('first_published') ?? get('updated_at') ?? ''),
      };
    }
    if (company.platform === 'ashby') {
      return {
        sourceUrl: String(get('jobUrl') ?? ''),
        title: String(get('title') ?? ''),
        company: company.name,
        location: String(get('location') ?? '') || fallback,
        descriptionHtml: String(get('descriptionHtml') ?? get('descriptionPlain') ?? ''),
        postedAt: String(get('publishedAt') ?? ''),
      };
    }
    if (company.platform === 'lever') {
      return {
        sourceUrl: String(get('hostedUrl') ?? ''),
        title: String(get('text') ?? ''),
        company: company.name,
        location: (get('categories') as { location?: string })?.location || fallback,
        descriptionHtml: String(get('description') ?? get('descriptionPlain') ?? ''),
        postedAt: get('createdAt') ? new Date(Number(get('createdAt'))).toISOString() : '',
      };
    }
    // recruitee
    return {
      sourceUrl: String(get('careers_url') ?? get('careers_apply_url') ?? ''),
      title: String(get('title') ?? get('position') ?? ''),
      company: company.name,
      location: [get('city'), get('country')].filter(Boolean).join(', ') || fallback,
      descriptionHtml: `${String(get('description') ?? '')} ${String(get('requirements') ?? '')}`,
      postedAt: String(get('published_at') ?? get('created_at') ?? ''),
    };
  }).filter((job): job is ParsedJob => Boolean(job?.sourceUrl && job.title && job.descriptionHtml.trim()));
}

async function fetchCompany(company: AtsCompany): Promise<ParsedJob[]> {
  try {
    const response = await fetch(feedUrl(company), { headers: { accept: 'application/json, application/xml' } });
    if (!response.ok) return [];
    return parseFeed(company, await response.text());
  } catch {
    // One unreachable or reshaped board must never fail the whole source.
    return [];
  }
}

/** Reads every configured board for one country. Boards are independent, so failures are isolated per company. */
export async function searchAtsBoards(country: Exclude<JobCountry, 'unknown'>): Promise<ParsedJob[]> {
  const companies = atsCompanies.filter((company) => company.country === country);
  const results = await Promise.all(companies.map(fetchCompany));
  const byUrl = new Map<string, ParsedJob>();
  for (const job of results.flat()) if (!byUrl.has(job.sourceUrl)) byUrl.set(job.sourceUrl, job);
  return [...byUrl.values()];
}
