/**
 * Privacy policy content, written from what the code actually does rather than from a template.
 * If the data handling changes, change this in the same commit.
 *
 * The CV entries are gated on CV_MATCHING_ENABLED rather than deleted. While the flag is false
 * this page must not tell a stranger their CV is stored and read, because it is not — that is a
 * false statement on the one page whose whole purpose is being true. If the feature returns, the
 * disclosure returns with it in the same change rather than being remembered.
 */
import { CV_MATCHING_ENABLED } from './features';

export const PRIVACY_UPDATED_ON = '2026-09-20';

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
    what: 'The job advertisements you have collected, and your notes on them',
    why: 'To keep your shortlist, application status and language corrections between visits. The advertisement text itself is read on the server to decide whether English is enough, and is not sent to your browser or shown here — it belongs to the employer who wrote it. What you see is the job’s facts, our verdict, the requirements we extracted, and a link to the original.',
    legalBasis: 'Performance of a contract.',
    kept: 'Until you delete them individually, reset the workspace, or delete your account.',
  },
  {
    what: 'Your search settings: the roles you are looking for, and required or excluded keywords',
    why: 'To run searches the way you configured them.',
    legalBasis: 'Performance of a contract.',
    kept: 'Until you change or delete them.',
  },
  {
    what: 'The listings your searches have already judged and set aside',
    why: 'So a repeated search does not re-read the same dead ends: when a page-fetching source returns a listing that cannot be imported — an unreadable page, an unsafe apply link, or an advertisement in the wrong country, too short to screen, or outside your searched roles — its address and the reason are kept, and later runs skip it without fetching it again.',
    legalBasis: 'Performance of a contract.',
    kept: 'Until you reset the workspace or delete your account.',
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

const cvDataItem: DataItem = {
  what: 'Your CV file and the text extracted from it',
  why: 'To score how well each job advertisement matches your experience, and to suggest the role to search for.',
  legalBasis: 'Performance of a contract. This is the core function you signed up for.',
  kept: 'Until you replace or delete it. Deleting a CV removes the stored file at the same time.',
};

if (CV_MATCHING_ENABLED) dataWeHold.splice(1, 0, cvDataItem);

/**
 * The page's own headline and summary, and the "where the data lives" list.
 *
 * These lived as hardcoded JSX in app/privacy/page.tsx, which is how the page went on promising
 * "Your CV stays yours" and "R2 (your CV file)" months after CV matching was shelved: the tests
 * checked this module, the copy was somewhere else, and both looked fine. Copy that makes a
 * factual claim about data handling belongs here, where it is covered.
 */
export const privacyHeadline = CV_MATCHING_ENABLED
  ? { lead: 'Your CV stays', emphasis: 'yours.' }
  : { lead: 'Your job search stays', emphasis: 'yours.' };

export const privacySummary = CV_MATCHING_ENABLED
  ? 'This page describes exactly what is stored, why, how long it is kept, and what you can do about it. '
    + 'It is written from what the software actually does rather than from a template. If you only read one '
    + 'line: your CV is never sent to any job site, aggregator, or AI service, and nothing about you is sold or shared.'
  : 'This page describes exactly what is stored, why, how long it is kept, and what you can do about it. '
    + 'It is written from what the software actually does rather than from a template. If you only read one '
    + 'line: search keywords and locations are sent to selected job sources; account credentials and saved advertisements are not sent to job sites or AI services.';

export const whereDataLives = [
  CV_MATCHING_ENABLED
    ? 'Data is stored in Cloudflare D1 (database) and R2 (your CV file). Cloudflare acts as a processor and is the only third party involved in hosting.'
    : 'Data is stored in Cloudflare D1. Cloudflare acts as a processor and is the only third party involved in hosting.',
  CV_MATCHING_ENABLED
    ? 'Administrators of this installation can see that an account exists, its email address, and how many jobs and CVs it holds. They cannot read your CV text or your job list.'
    : 'Administrators of this installation can see that an account exists, its email address, and how many jobs it holds. They cannot read your job list.',
  CV_MATCHING_ENABLED
    ? 'Job searches send only your role keywords to the job sources listed on the sources page. They never receive your CV, your email, or anything identifying you.'
    : 'Job searches send only your role keywords to the job sources listed on the sources page. They never receive your email or anything identifying you.',
  'There is no automated decision-making that produces legal or similarly significant effects. The language verdict is a suggestion for you to review, and you can correct any of them.',
];

export const notCollected = [
  'No advertising, marketing or third-party analytics of any kind.',
  'No tracking cookies, pixels, fingerprinting or cross-site tracking.',
  'No profiling, no automated decisions with legal effect, and nothing sold or shared with anyone.',
  'Your account credentials and saved advertisements are not sent to job sites or AI services. Search keywords and locations are sent to the sources you search.',
  'No page-by-page browsing history, no referrer logging, no session recording.',
];

export const yourRights = [
  {
    right: 'Access and portability',
    how: 'Export your entire workspace as JSON or CSV from the dashboard at any time. It is a complete copy of what is stored about you.',
  },
  {
    right: 'Rectification',
    how: 'Change your email address and password in Settings, and edit your search criteria at any time.',
  },
  {
    right: 'Erasure',
    how: 'Delete individual jobs, reset the whole workspace, or delete your account outright in Settings. Deletion is immediate and permanent.',
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
