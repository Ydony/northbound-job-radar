/**
 * Privacy policy content, written from what the code actually does rather than from a template.
 * If the data handling changes, change this in the same commit.
 */
export const PRIVACY_UPDATED_ON = '2026-08-28';

export interface DataItem {
  what: string;
  why: string;
  legalBasis: string;
  kept: string;
}

export const dataWeHold: DataItem[] = [
  {
    what: 'Your email address and a hash of your password',
    why: 'To let you sign in and to reach your own workspace. The password itself is never stored: only a PBKDF2-SHA256 hash with a salt unique to you.',
    legalBasis: 'Performance of a contract (providing the account you asked for).',
    kept: 'Until you delete your account, which removes it immediately.',
  },
  {
    what: 'Your CV file and the text extracted from it',
    why: 'To score how well each job advertisement matches your experience, and to suggest the role to search for.',
    legalBasis: 'Performance of a contract. This is the core function you signed up for.',
    kept: 'Until you replace or delete it. Deleting a CV removes the stored file at the same time.',
  },
  {
    what: 'The job advertisements you have collected, and your notes on them',
    why: 'To keep your shortlist, application status and language corrections between visits.',
    legalBasis: 'Performance of a contract.',
    kept: 'Until you delete them individually, reset the workspace, or delete your account.',
  },
  {
    what: 'Your search settings: roles, location, keywords, filters',
    why: 'To run searches the way you configured them.',
    legalBasis: 'Performance of a contract.',
    kept: 'Until you change or delete them.',
  },
  {
    what: 'Sign-in records: the email tried, the IP address, and whether it succeeded',
    why: 'To detect and slow down password guessing. This is the only place an IP address is stored.',
    legalBasis: 'Legitimate interest in keeping accounts secure.',
    kept: 'Automatically deleted after 30 days.',
  },
  {
    what: 'A daily count of visits and distinct visitors',
    why: 'To know roughly how much the site is used. See "How visits are counted" below - this is a counter, not a profile.',
    legalBasis: 'Legitimate interest in understanding basic usage, with no identification of anyone.',
    kept: 'The daily totals are aggregate and kept indefinitely. The de-duplication markers are deleted when the day ends.',
  },
];

export const notCollected = [
  'No advertising, marketing or third-party analytics of any kind.',
  'No tracking cookies, pixels, fingerprinting or cross-site tracking.',
  'No profiling, no automated decisions with legal effect, and nothing sold or shared with anyone.',
  'Your CV is never sent to a job site, an aggregator, or any AI or machine-learning service.',
  'No page-by-page browsing history, no referrer logging, no session recording.',
];

export const yourRights = [
  {
    right: 'Access and portability',
    how: 'Export your entire workspace as JSON or CSV from the dashboard at any time. It is a complete copy of what is stored about you.',
  },
  {
    right: 'Rectification',
    how: 'Change your email address and password in Settings, and edit your search criteria and CVs at any time.',
  },
  {
    right: 'Erasure',
    how: 'Delete individual jobs, delete either CV, reset the whole workspace, or delete your account outright in Settings. Deletion is immediate and permanent, including the stored CV file.',
  },
  {
    right: 'Restriction and objection',
    how: 'Stop using the search at any time; nothing runs on a schedule and no search happens unless you press a button.',
  },
  {
    right: 'Complaint',
    how: 'You may complain to your national data protection authority. In the Netherlands this is the Autoriteit Persoonsgegevens; in Switzerland, the FDPIC.',
  },
];

export const cookieNotice = {
  summary: 'One cookie, and it is the one that keeps you signed in.',
  detail: [
    {
      name: 'ike_session',
      purpose: 'Keeps you signed in after you log in. It contains only your account id and an expiry, signed so it cannot be altered.',
      type: 'Strictly necessary',
      expiry: '14 days, or immediately when you sign out.',
    },
  ],
  why: 'Under the ePrivacy rules a consent banner is required for cookies that are not strictly necessary - advertising, analytics and tracking cookies. This site sets none of those, so there is nothing to ask consent for and no banner is shown. The sign-in cookie is exempt because the service cannot work without it, and it is only set once you choose to sign in.',
};

export const visitCounting = [
  'Visits are counted without identifying anyone and without a cookie.',
  'To avoid counting the same person twice in one day, a short marker is derived from a secret that changes every day. The IP address and browser used to derive it are never stored.',
  'Because the secret changes daily and the markers are deleted once the day ends, two visits on different days cannot be connected, and a marker cannot be traced back to a person.',
  'What remains is a plain daily number: how many visits, and how many distinct visitors.',
];
