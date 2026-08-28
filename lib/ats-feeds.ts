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
  /** Home market. Postings are still routed by their own location, so an international company feeds both countries. */
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
  // International scale-ups and mid-size firms hiring across NL/CH
  { slug: 'elastic', name: 'Elastic', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'conclusion', name: 'Conclusion', platform: 'recruitee', country: 'netherlands' },
  { slug: 'valtech', name: 'Valtech', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'centric', name: 'Centric', platform: 'recruitee', country: 'netherlands' },
  { slug: 'greenchoice', name: 'Greenchoice', platform: 'recruitee', country: 'netherlands' },
  { slug: 'miro', name: 'Miro', platform: 'ashby', country: 'netherlands' },
  { slug: 'bird', name: 'Bird (MessageBird)', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'hackerone', name: 'HackerOne', platform: 'ashby', country: 'netherlands' },
  { slug: 'crisp', name: 'Crisp', platform: 'ashby', country: 'netherlands' },
  { slug: 'leapsome', name: 'Leapsome', platform: 'ashby', country: 'netherlands' },
  { slug: 'typeform', name: 'Typeform', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'fairphone', name: 'Fairphone', platform: 'personio', country: 'netherlands' },
  { slug: 'trivago', name: 'Trivago', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'dashmote', name: 'Dashmote', platform: 'recruitee', country: 'netherlands' },
  { slug: 'flink', name: 'Flink', platform: 'ashby', country: 'netherlands' },
  { slug: 'contentful', name: 'Contentful', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'seenons', name: 'Seenons', platform: 'recruitee', country: 'netherlands' },
  { slug: 'xebia', name: 'Xebia', platform: 'personio', country: 'netherlands' },
  // Master-data and data-governance vendors: closest match to the derived CV roles
  { slug: 'collibra', name: 'Collibra', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'reltio', name: 'Reltio', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'atlan', name: 'Atlan', platform: 'ashby', country: 'netherlands' },
  { slug: 'starburst', name: 'Starburst', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'montecarlodata', name: 'Monte Carlo', platform: 'ashby', country: 'netherlands' },
  { slug: 'xomnia', name: 'Xomnia', platform: 'recruitee', country: 'netherlands' },
  { slug: 'bearingpoint', name: 'BearingPoint', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'statworx', name: 'statworx', platform: 'personio', country: 'switzerland' },
  // Supply chain and freight technology
  { slug: 'flexport', name: 'Flexport', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'project44', name: 'project44', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'fourkites', name: 'FourKites', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'forto', name: 'Forto', platform: 'ashby', country: 'netherlands' },
  // Swiss corporates and telecom
  { slug: 'swisscom', name: 'Swisscom', platform: 'recruitee', country: 'switzerland' },
  { slug: 'sunrise', name: 'Sunrise', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'comet', name: 'Comet Group', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'basilea', name: 'Basilea Pharmaceutica', platform: 'personio', country: 'switzerland' },
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

let cached: { at: number; jobs: ParsedJob[] } | undefined;
const CACHE_MS = 60_000;

/**
 * Reads every configured board once and serves both country adapters from that result, so an
 * international company contributes its Swiss and its Dutch roles rather than only its home
 * market. Boards are independent, so a failure is isolated to one company. The scrape route
 * assigns each posting a country from its own location, which is what filters this list.
 */
export async function searchAtsBoards(): Promise<ParsedJob[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.jobs;
  const results = await Promise.all(atsCompanies.map(fetchCompany));
  const byUrl = new Map<string, ParsedJob>();
  for (const job of results.flat()) if (!byUrl.has(job.sourceUrl)) byUrl.set(job.sourceUrl, job);
  const jobs = [...byUrl.values()];
  cached = { at: Date.now(), jobs };
  return jobs;
}
