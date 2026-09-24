import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeJobLanguage, analyzeLanguage, type LanguageStatus } from '../lib/analysis';
import { freehireJobToParsedJob, type FreehireJob } from '../lib/freehire';
import { advertisementToParsedJob, type JobRoomAdvertisement } from '../lib/job-room';
import { stripHtml } from '../lib/jobsch';
import {
  recordedEligibleCh,
  recordedEligibleNl,
  recordedIneligibleUpstream,
} from './fixtures/freehire';

/**
 * INT-13 (#169), language-quality half: re-verify the language gate on the new
 * public sources using the labelled-corpus approach from #4.
 *
 * Every case below runs through the real ingest path — adapter parse, then
 * `stripHtml`, then the gate — against RECORDED fixtures only, never live:
 * FreeHire cases use the captured API records in `tests/fixtures/freehire.ts`
 * plus synthetic HTML-shaped blocking cases; Job-Room cases mirror the recorded
 * API shape (search answers `{ jobAdvertisement }` wrappers, descriptions carry
 * a `languageIsoCode`, requirements arrive as structured `languageSkills`).
 *
 * Measured 2026-09-24: the gate needed no change on these sources, so this
 * measurement plus the fixtures IS the deliverable — no `lib/analysis.ts`
 * behaviour was touched and `NORMALIZATION_VERSION` is unchanged.
 */

interface LabelledCase {
  id: string;
  expected: LanguageStatus;
  actual: LanguageStatus;
  tests: string;
}

/** Neutral English padding so wording cases are judged on wording, not length. */
const pad = ' About the team. You will join a small product group and own delivery end to end. '
  + 'We review each other work and write things down. The team is distributed across two offices '
  + 'with a hybrid arrangement. We offer a permanent contract, a training budget, and twenty-six '
  + 'days of holiday. Hiring is three conversations and a decision within a week.';

const longEnglishBody = `${'You will work in English with a distributed team across four countries. '.repeat(20)}${pad}`.trim();

function freehireCase(
  id: string,
  job: FreehireJob,
  expected: LanguageStatus,
  tests: string,
): LabelledCase {
  const parsed = freehireJobToParsedJob({ closed_at: null, countries: ['ch'], ...job }, 'Switzerland');
  assert.ok(parsed, `${id}: the adapter must accept the fixture`);
  return {
    id,
    expected,
    actual: analyzeLanguage(stripHtml(parsed.descriptionHtml), parsed.title).status,
    tests,
  };
}

function jobRoomAdvertisement(
  id: string,
  descriptions: Array<{ languageIsoCode: string; title: string; description: string }>,
  languageSkills: Array<{ languageIsoCode: string; spokenLevel: string | null; writtenLevel: string | null }>,
): JobRoomAdvertisement {
  return {
    id,
    publication: { startDate: '2026-09-10', endDate: '2026-12-31' },
    status: 'PUBLISHED_PUBLIC',
    jobContent: {
      externalUrl: null,
      jobDescriptions: descriptions,
      company: { name: 'Example AG' },
      location: { city: 'Bern', postalCode: '3000', cantonCode: 'BE' },
      languageSkills,
    },
  };
}

function jobRoomCase(
  id: string,
  advertisement: JobRoomAdvertisement,
  expected: LanguageStatus,
  tests: string,
): LabelledCase {
  const parsed = advertisementToParsedJob(advertisement);
  assert.ok(parsed, `${id}: the adapter must accept the fixture`);
  return {
    id,
    expected,
    actual: analyzeJobLanguage(stripHtml(parsed.descriptionHtml), parsed.title, parsed.languageSkills).status,
    tests,
  };
}

const proficientEn = [{ languageIsoCode: 'en', spokenLevel: 'PROFICIENT', writtenLevel: 'PROFICIENT' }];

function publicSourceSample(): LabelledCase[] {
  return [
    // ------------------------------------------------------- FreeHire (recorded)
    freehireCase(
      'freehire-recorded-ch-mandatory-german',
      recordedEligibleCh,
      'blocked',
      'recorded greenhouse/CH ad: "Fluent German language skills" inside an HTML list; upstream tags it posting_language=en, which the gate correctly does not trust',
    ),
    freehireCase(
      'freehire-recorded-nl-english-only',
      recordedEligibleNl,
      'pass',
      'recorded greenhouse/NL ad: long English advertisement, no local language named',
    ),
    freehireCase(
      'freehire-recorded-optional-german',
      recordedIneligibleUpstream,
      'review',
      'recorded smartrecruiters/CH ad: "German is considered an advantage" — optional stays review, never pass (ineligible at ingest, still a valid language sample)',
    ),
    // --------------------------------------------- FreeHire-shaped blocking cases
    freehireCase(
      'freehire-html-level-table',
      {
        public_slug: 'operations-specialist-example-a1b2c3',
        source: 'greenhouse',
        title: 'Operations Specialist',
        company: 'Example BV',
        location: 'Amsterdam',
        description: `<div><p>Requirements:</p><ul><li>Five years of experience</li>`
          + `<li>Dutch: B2 level or higher</li></ul></div><p>${pad} ${pad}</p>`,
      },
      'blocked',
      'a CEFR level table inside FreeHire HTML markup must block like the plain-text form',
    ),
    freehireCase(
      'freehire-title-names-language',
      {
        public_slug: 'customer-success-manager-example-d4e5f6',
        source: 'lever',
        title: 'German-speaking Customer Success Manager',
        company: 'Example AG',
        location: 'Zurich, Switzerland',
        description: `<div><p>${longEnglishBody}</p></div>`,
      },
      'blocked',
      'the language named in the headline with a clean body — aggregator copy carries its only signal in the title',
    ),
    freehireCase(
      'freehire-html-french-requirement',
      {
        public_slug: 'client-advisor-example-g7h8i9',
        source: 'ashby',
        title: 'Client Advisor',
        company: 'Example SA',
        location: 'Geneva, Switzerland',
        description: `<div><p>${longEnglishBody}</p><p>Excellente maitrise du francais requise pour ce poste.</p></div>`,
      },
      'blocked',
      'a French requirement cue inside HTML markup must block, not pass as English-sufficient',
    ),
    // -------------------------------------------------------- Job-Room (shaped)
    jobRoomCase(
      'job-room-structured-english-only',
      jobRoomAdvertisement('jr-pass-1', [
        { languageIsoCode: 'de', title: 'Datenanalyst', description: 'Kurze deutsche Vorschau.' },
        { languageIsoCode: 'en', title: 'Data Analyst', description: longEnglishBody },
      ], proficientEn),
      'pass',
      'the English description wins over the German one and employer-declared English carries the pass',
    ),
    jobRoomCase(
      'job-room-structured-german-required',
      jobRoomAdvertisement('jr-blocked-1', [
        { languageIsoCode: 'en', title: 'Data Analyst', description: longEnglishBody },
      ], [
        { languageIsoCode: 'de', spokenLevel: 'PROFICIENT', writtenLevel: 'PROFICIENT' },
        { languageIsoCode: 'en', spokenLevel: 'INTERMEDIATE', writtenLevel: 'INTERMEDIATE' },
      ]),
      'blocked',
      'employer-declared German at working level blocks even when the prose reads clean',
    ),
    jobRoomCase(
      'job-room-prose-block-beats-structured-pass',
      jobRoomAdvertisement('jr-blocked-2', [
        { languageIsoCode: 'en', title: 'Data Analyst', description: `${longEnglishBody} Fluent German is required.` },
      ], proficientEn),
      'blocked',
      'an explicit blocking phrase in the body still wins when the structured list is incomplete',
    ),
    jobRoomCase(
      'job-room-structured-silent',
      jobRoomAdvertisement('jr-review-1', [
        { languageIsoCode: 'en', title: 'Data Analyst', description: longEnglishBody },
      ], [{ languageIsoCode: 'fr', spokenLevel: 'BASIC', writtenLevel: 'BASIC' }]),
      'review',
      'no local language at working level but no English either — review, never pass',
    ),
    jobRoomCase(
      'job-room-short-preview',
      jobRoomAdvertisement('jr-unknown-1', [
        { languageIsoCode: 'en', title: 'Data Analyst', description: 'Short preview without the requirements section. '.repeat(5).trim() },
      ], []),
      'unknown',
      'a preview with no skills declared is too short to judge — absence of evidence, not a pass',
    ),
    jobRoomCase(
      'job-room-short-french-preview',
      jobRoomAdvertisement('jr-blocked-3', [
        {
          languageIsoCode: 'en',
          title: 'Business Analyst - Master Data (H/F)',
          description: 'Introduction Pour notre division Systemes d-Information, nous recherchons un(e) '
            + 'Business Analyst - Donnees de base. Votre mission sera de faire le pont entre les '
            + 'exigences metiers et les solutions techniques.',
        },
      ], []),
      'blocked',
      'a short preview still blocks when its language is unambiguously not English (the Rolex shape)',
    ),
    jobRoomCase(
      'job-room-german-only-descriptions',
      jobRoomAdvertisement('jr-blocked-4', [
        {
          languageIsoCode: 'de',
          title: 'System Engineer',
          description: 'Ihre neue Herausforderung Betrieb und Unterhalt der Serverinfrastruktur mit '
            + 'Schwerpunkt auf Microsoft-Technologien. Sie bringen Erfahrung mit und arbeiten eng '
            + 'mit unseren Kunden zusammen. '.repeat(8).trim(),
        },
      ], []),
      'blocked',
      'no English description at all: the German body blocks on prose, however long',
    ),
    jobRoomCase(
      'job-room-structured-pass-on-preview',
      jobRoomAdvertisement('jr-pass-2', [
        { languageIsoCode: 'en', title: 'Data Analyst', description: 'Short preview without the requirements section. '.repeat(5).trim() },
      ], proficientEn),
      'pass',
      'employer-declared English carries even a short text — the declaration, not the prose, is the evidence',
    ),
  ];
}

test('no public-source advertisement requiring a local language is ever passed as English', () => {
  // The product's central promise, re-measured on the new public sources. Over-blocking costs a
  // job; a false pass costs an application written for a role that was never open. Ambiguous ads
  // must go to review, never pass — so review-labelled cases passing counts as a false pass too.
  const falsePasses = publicSourceSample().filter(
    (entry) => (entry.expected === 'blocked' || entry.expected === 'review') && entry.actual === 'pass',
  );
  assert.deepEqual(
    falsePasses.map((entry) => `${entry.id} (${entry.tests})`),
    [],
    'a public-source advertisement that was not confirmed English-sufficient was reported as a pass',
  );
});

test('every public-source sample case receives the verdict it is labelled with', () => {
  const wrong = publicSourceSample()
    .filter((entry) => entry.actual !== entry.expected)
    .map((entry) => `${entry.id}: expected ${entry.expected}, got ${entry.actual} — ${entry.tests}`);
  assert.deepEqual(wrong, [], `${wrong.length} public-source cases disagree`);
});

test('short public-source previews need an employer declaration to pass', () => {
  // The length gate on the new shapes, both sides: bare short prose is 'unknown' no matter how
  // English it reads, while employer-declared English carries the same short text. The asymmetry
  // is deliberate — the declaration, not the prose, is the evidence in the second case.
  const byId = new Map(publicSourceSample().map((entry) => [entry.id, entry.actual]));
  assert.equal(byId.get('job-room-short-preview'), 'unknown');
  assert.equal(byId.get('job-room-structured-pass-on-preview'), 'pass');
});

test('pass verdicts on the public-source sample are all earned (precision 1)', () => {
  // Precision of the pass bucket is the number that matters for launch: every advertisement
  // shown as English-sufficient must actually be labelled so. 14 cases: 8 blocked, 2 review,
  // 3 pass, 1 unknown — 0 false passes, pass precision 3/3, unknown rate 1/14.
  const sample = publicSourceSample();
  const passed = sample.filter((entry) => entry.actual === 'pass');
  assert.ok(passed.length > 0, 'the sample must contain passes to measure their precision');
  const precision = passed.filter((entry) => entry.expected === 'pass').length / passed.length;
  assert.equal(precision, 1, 'every pass verdict must be a labelled pass');
});
