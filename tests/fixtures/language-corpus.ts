/**
 * A labelled corpus for measuring the language gate, which is the product.
 *
 * **Why these advertisements are synthetic.** Card #4 asked for a corpus of *real* advertisement
 * text. That cannot be committed here. `docs/SOURCE_POLICY.md` §1 separates reading a source from
 * republishing it: the advertisement text belongs to the employer, not to the source and not to
 * us, and this repository is public. A file of real ads would be exactly the republication that
 * #34 exists to stop, and git history makes it permanent.
 *
 * So each entry below reproduces a *pattern* the gate has to handle - the wordings already
 * encoded in `lib/language-rules.ts`, which were themselves earned from real ads - rather than
 * reproducing any advertisement. That keeps the measurement honest about what the rules do while
 * publishing nothing that is not ours.
 *
 * Each case carries the verdict it must receive and a note saying what it is testing, so a
 * failure names the behaviour that broke rather than an index.
 */
import type { LanguageStatus } from '../../lib/analysis';

export interface CorpusCase {
  id: string;
  title: string;
  description: string;
  expected: LanguageStatus;
  /** What this case exists to catch. Printed when it fails. */
  tests: string;
}

/**
 * Padding so a case is judged on its wording rather than on being too short to judge.
 *
 * Deliberately bland and deliberately over 900 characters, because MIN_CHARS_TO_CONFIRM_ENGLISH
 * is checked before the prose test: a case meant to measure a phrase rule would otherwise come
 * back 'unknown' and prove nothing.
 */
const body = (specific: string) => `${specific}

About the role. You will join a small product team and own delivery end to end, from the first
conversation with a stakeholder through to what runs in production. The work is a mix of new
build and improving what already exists, and you will be trusted to decide which of those a given
week needs. We review each other work, we write things down, and we would rather ship something
small and correct than something large and hopeful.

About us. We are a mid-sized company with an established product and customers who depend on it.
The team is distributed across two offices with a hybrid arrangement, typically two days a week in
person. We are deliberately unglamorous about process: a planning conversation on Monday, a demo on
Thursday, and otherwise long stretches of uninterrupted time to do the work.

What we offer. A permanent contract, a training budget you are expected to spend, a pension
contribution, and twenty-six days of holiday. Salary is set against a published band and we tell
you the band before you interview rather than asking what you earn now.

How we hire. A conversation with the hiring manager, a technical discussion with two people you
would work alongside, and a final conversation about the offer. Three steps, no take-home
exercise, and we give a decision within a week of the last one.`;

export const languageCorpus: CorpusCase[] = [
  // ---------------------------------------------------------------- blocked
  {
    id: 'blocked-german-fluent',
    title: 'Backend Engineer',
    description: body('Requirements: fluent in German and solid English. Sehr gute Deutschkenntnisse.'),
    expected: 'blocked',
    tests: 'a plain mandatory-fluency phrase before the language name',
  },
  {
    id: 'blocked-dutch-required',
    title: 'Operations Coordinator',
    description: body('Dutch is required for this position, as you will speak with local suppliers daily.'),
    expected: 'blocked',
    tests: 'the requirement stated after the language name rather than before it',
  },
  {
    id: 'blocked-title-names-language',
    title: 'German Language Customer Advisor',
    description: body('You will support our customers by phone and email across the DACH region.'),
    expected: 'blocked',
    tests: 'the language named in the job title, with a body that never repeats the requirement',
  },
  {
    id: 'blocked-colon-level',
    title: 'Projektmanager',
    description: body('Sprachen: Deutsch: C2, Englisch: B2. Sie arbeiten eng mit unseren Kunden zusammen.'),
    expected: 'blocked',
    tests: 'a level table, where the gap between cue and language crosses a colon',
  },
  {
    id: 'blocked-second-language-mandatory',
    title: 'Account Manager',
    description: body('German is a nice to have. Fluency in French is essential for this role.'),
    expected: 'blocked',
    tests: 'an optional language before a mandatory one - the optional cue must not silence the requirement',
  },
  {
    id: 'blocked-native-speaker',
    title: 'Copywriter',
    description: body('We are looking for a native Dutch speaker to own our customer communications.'),
    expected: 'blocked',
    tests: 'native-speaker phrasing rather than an explicit requirement word',
  },

  // ----------------------------------------------------------------- review
  {
    id: 'review-optional-german',
    title: 'Data Engineer',
    description: body('German is a plus but not required; the team works in English day to day.'),
    expected: 'review',
    tests: 'an explicitly optional language - worth a look, not a rejection',
  },
  {
    id: 'review-language-mentioned-bare',
    title: 'Support Specialist',
    description: body('Our customers are mostly in the Netherlands and Belgium, and some prefer Dutch.'),
    expected: 'review',
    tests: 'a language named with no requirement attached at all',
  },
  {
    id: 'review-spanish-desirable',
    title: 'Partnerships Lead',
    description: body('Spanish would be an advantage given our expansion into the Iberian market.'),
    expected: 'review',
    tests: 'Spanish, the most recently added language table',
  },

  // ---------------------------------------------------------------- unknown
  {
    id: 'unknown-teaser',
    title: 'Senior Software Engineer',
    description: 'Join a fast-growing team building tools people rely on. Apply now to find out more.',
    expected: 'unknown',
    tests: 'an aggregator teaser - too short to confirm anything, and not a failure of English',
  },
  {
    id: 'unknown-teaser-that-reads-english',
    title: 'Product Designer',
    description: 'We are hiring a product designer for our Amsterdam studio. Competitive salary, hybrid working.',
    expected: 'unknown',
    tests: 'a short ad that reads as fine English - absence of evidence is not evidence',
  },

  // ------------------------------------------------------------------- pass
  {
    id: 'pass-english-only',
    title: 'Platform Engineer',
    description: body('You will work in English with a distributed team across four countries.'),
    expected: 'pass',
    tests: 'the ordinary case - long, English, no local language named',
  },
  {
    id: 'pass-english-named-as-the-requirement',
    title: 'Technical Writer',
    description: body('Requirements: excellent written English. All our documentation is in English.'),
    expected: 'pass',
    tests: 'English itself stated as mandatory must not trip the local-language rules',
  },
  // ------------------------------------- reported by the owner, 2026-09-18
  {
    id: 'blocked-short-french-preview',
    title: 'Business Analyst - Master Data (H/F)',
    description: 'Introduction Pour notre division Systemes d-Information, nous recherchons un(e) Business Analyst - '
      + 'Donnees de base. Votre mission sera de faire le pont entre les exigences metiers et les solutions '
      + 'techniques pour garantir l-excellence de nos donnees de reference.',
    expected: 'blocked',
    tests: 'a short preview of a French advertisement. Under 900 characters, but its language is not in doubt',
  },
  {
    id: 'blocked-short-german-preview',
    title: 'Senior System Engineer',
    description: 'Ihre neue Herausforderung Betrieb und Unterhalt der Serverinfrastruktur mit Schwerpunkt auf '
      + 'Microsoft-Technologien. Sie bringen Erfahrung mit und arbeiten eng mit unseren Kunden zusammen.',
    expected: 'blocked',
    tests: 'the same for German: a preview is long enough to rule English out, though not to confirm it',
  },
  // ------------------------------------- found by probing this corpus, 2026-09-08
  {
    id: 'blocked-unlisted-language',
    title: 'Support Engineer',
    description: body('Fluent Polish is required to support our Warsaw customers.'),
    expected: 'blocked',
    tests: 'a language outside the five local ones - this returned pass until the other-language table existed',
  },
  {
    id: 'review-nationality-not-language',
    title: 'Compliance Analyst',
    description: body('Experience with Dutch financial regulation and the German market is welcome.'),
    expected: 'pass',
    tests: 'a language word used as a nationality or market (regulation/market), not a language requirement',
  },
  {
    id: 'review-negated-requirement',
    title: 'Platform Engineer',
    description: body('No German is required for this role; we work entirely in English.'),
    expected: 'pass',
    tests: 'an explicit denial ("No German is required") clears the mention; "German is not required" stays review',
  },
  {
    id: 'review-language-as-a-benefit',
    title: 'Platform Engineer',
    description: body('We offer free Dutch lessons to everyone who joins us from abroad.'),
    expected: 'pass',
    tests: 'a language offered as help (benefit verb + lessons), not asked as a requirement',
  },
  {
    id: 'review-bilingual',
    title: 'Client Advisor',
    description: body('You are bilingual in English and French and comfortable switching between them.'),
    expected: 'blocked',
    tests: '"bilingual in X and Y" is a requirement for the non-English language',
  },
  // ------------------------- independent review of the gate, issues #79 / #80
  // Six exhibits, each reproduced by hand before the rule was touched. Two were false passes,
  // which cost a wasted application; two were false blocks, which hide the job entirely.
  {
    id: 'blocked-denial-from-previous-sentence',
    title: 'Platform Engineer',
    description: body('No travel. German is required.'),
    expected: 'blocked',
    tests: 'a denial belongs to its own sentence - "No travel." must not clear "German is required"',
  },
  {
    id: 'review-language-used-for-regulatory-work',
    title: 'Compliance Analyst',
    description: body('You will read and write Dutch for regulatory reports.'),
    expected: 'review',
    tests: 'a preposition breaks the noun phrase, so this is Dutch the language, not a market use',
  },
  {
    id: 'review-qualified-optional',
    title: 'Client Advisor',
    description: body('Fluent Dutch is a plus for this role.'),
    expected: 'review',
    tests: 'a qualifier must not outrank what the sentence goes on to say - "is a plus" still counts',
  },
  {
    id: 'blocked-cue-does-not-cross-a-clause',
    title: 'Client Advisor',
    description: body('Fluent German is required, but Dutch is a plus.'),
    expected: 'blocked',
    tests: 'German blocks; the cue must not also bind forward across ", but" onto Dutch',
  },
  {
    id: 'pass-non-english-denial',
    title: 'Platform Engineer',
    description: body('Geen Duits vereist; wij werken volledig in het Engels.'),
    expected: 'pass',
    tests: 'a Dutch-language denial still clears, so narrowing the window did not break other languages',
  },
  // ------------------------------------- post-merge review of #74, issue #78
  {
    id: 'blocked-denial-plus-requirement',
    title: 'Platform Engineer',
    description: body('No German is required for onboarding, but fluent German is required for client work.'),
    expected: 'blocked',
    tests: 'a denial and a real requirement in one sentence - the denial clears only its own occurrence',
  },
  {
    id: 'review-benefit-then-ordinary-mention',
    title: 'Platform Engineer',
    description: body('We offer free Dutch lessons. Dutch is the day-to-day working language here.'),
    expected: 'review',
    tests: 'a benefit exempts only its own occurrence; a second ordinary mention still costs a glance',
  },
  {
    id: 'review-cue-bound-to-market-noun',
    title: 'Legal Counsel',
    description: body('Knowledge of Dutch law is required for this position.'),
    expected: 'review',
    tests: 'a requirement cue bound to a law/market use is ambiguous - review, never blocked, because blocking hides the job',
  },
  {
    id: 'review-market-knowledge-required',
    title: 'Account Executive',
    description: body('Experience with the German market is required for this territory.'),
    expected: 'review',
    tests: 'market knowledge asked with "required" is not a language requirement; it must not block',
  },
  {
    id: 'pass-market-word-in-title',
    title: 'German Market Analyst',
    description: body('You will own pipeline reporting for the DACH region and work in English.'),
    expected: 'pass',
    tests: 'a language word used as a market in the job title, with a clean English body',
  },
  {
    id: 'review-marketing-compound',
    title: 'Marketing Manager',
    description: body('You will lead German marketing campaigns from our Amsterdam office.'),
    expected: 'review',
    tests: "'marketing' is not the market noun - a compound word never triggers the nationality exemption",
  },
  {
    id: 'review-denial-without-cue',
    title: 'Platform Engineer',
    description: body('Not a word of Dutch is needed; the entire company works in English.'),
    expected: 'review',
    tests: 'a denial with no requirement cue attached stays review - the gate cannot verify what was never bound',
  },

  {
    id: 'pass-place-names-not-languages',
    title: 'Regional Manager',
    description: body('You will cover our Zurich, Geneva and Amsterdam offices, travelling roughly monthly.'),
    expected: 'pass',
    tests: 'Swiss and Dutch place names must not be read as language requirements',
  },
];
