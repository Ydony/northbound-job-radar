const sourceHosts: Record<string, string> = {
  'jobs.ch': 'jobs.ch',
  'www.jobs.ch': 'jobs.ch',
  'jobup.ch': 'jobup.ch',
  'www.jobup.ch': 'jobup.ch',
  'jobscout24.ch': 'JobScout24',
  'www.jobscout24.ch': 'JobScout24',
  'ch.indeed.com': 'Indeed Switzerland',
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
