export interface JobSourceLink {
  name: string;
  url: string;
  note: string;
  focus: string;
}

const sourceHosts: Record<string, string> = {
  'jobs.ch': 'jobs.ch',
  'www.jobs.ch': 'jobs.ch',
  'nl.indeed.com': 'Indeed Netherlands',
  'iamsterdam.com': 'I amsterdam',
  'www.iamsterdam.com': 'I amsterdam',
  'iamexpat.nl': 'IamExpat',
  'www.iamexpat.nl': 'IamExpat',
  'undutchables.nl': 'Undutchables',
  'www.undutchables.nl': 'Undutchables',
  'nationalevacaturebank.nl': 'Nationale Vacaturebank',
  'www.nationalevacaturebank.nl': 'Nationale Vacaturebank',
};

function indeedNetherlandsUrl(role: string) {
  const url = new URL('https://nl.indeed.com/jobs');
  url.searchParams.set('q', [role.trim(), 'English'].filter(Boolean).join(' '));
  url.searchParams.set('l', 'Amsterdam');
  return url.toString();
}

export function netherlandsJobSources(role = ''): JobSourceLink[] {
  return [
    {
      name: 'I amsterdam',
      url: 'https://www.iamsterdam.com/en/live-work-study/work/job-search',
      note: 'English-speaking vacancies in Amsterdam and the wider metropolitan area.',
      focus: 'Amsterdam · English focused',
    },
    {
      name: 'IamExpat',
      url: 'https://www.iamexpat.nl/career/jobs-netherlands',
      note: 'Roles published for international candidates across the Netherlands.',
      focus: 'Netherlands · Internationals',
    },
    {
      name: 'Undutchables',
      url: 'https://undutchables.nl/vacancies/',
      note: 'International recruitment board with a preferred-language filter.',
      focus: 'Netherlands · Language filter',
    },
    {
      name: 'Indeed Netherlands',
      url: indeedNetherlandsUrl(role),
      note: 'A broad Amsterdam search prefilled with your role and English.',
      focus: 'Amsterdam · Broad coverage',
    },
    {
      name: 'Nationale Vacaturebank',
      url: 'https://www.nationalevacaturebank.nl/',
      note: 'Large national board; use Northbound to reject Dutch-required ads.',
      focus: 'Netherlands · Broad coverage',
    },
  ];
}

function isUnsafeHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(':')) return true;
  return !host.includes('.');
}

/** Manual imports never fetch this URL server-side; validation keeps saved apply links HTTPS and non-local. */
export function isSafeManualJobUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !isUnsafeHostname(parsed.hostname);
  }
  catch {
    return false;
  }
}

export function sourceNameForUrl(value: string) {
  try {
    return sourceHosts[new URL(value).hostname.toLowerCase()] ?? 'Employer site';
  }
  catch {
    return 'Source site';
  }
}
