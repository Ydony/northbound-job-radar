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
  // Cloud metadata endpoints resolve only inside their own cloud, which is where this
  // server runs: reaching one server-side bypasses every audience and tenancy check.
  // The IP form (169.254.169.254) is already refused below; the names are not IPs.
  if (host === 'metadata.google' || host === 'metadata.google.internal'
    || host.endsWith('.metadata.google') || host.endsWith('.metadata.google.internal')) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(':')) return true;
  // The URL parser normalizes hex/octal/decimal IPv4 forms to the dotted quad above, but a
  // numeric host it does not recognize (five parts, six digits) resolves nowhere public:
  // no public TLD is all-numeric, so every label numeric means an IP encoding, not a name.
  const labels = host.split('.');
  if (labels.length > 1 && labels.every((part) => /^(0x[0-9a-f]+|0[0-7]*|[0-9]+)$/i.test(part))) return true;
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
