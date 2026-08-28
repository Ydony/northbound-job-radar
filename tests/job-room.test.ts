import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeStructuredLanguages } from '../lib/analysis';
import { advertisementToParsedJob } from '../lib/job-room';
import { sourceInfoForUrl, sourceJobIdFromUrl } from '../lib/job-identity';

const advertisement = {
  id: 'd483da4d-c4dc-4b17-bbf2-15edcf5f0fcd',
  publicationStartDate: '2026-08-27',
  jobContent: {
    externalUrl: null,
    jobDescriptions: [{ languageIsoCode: 'de', title: '<em>Data</em> Analyst', description: 'Wir suchen eine Person fuer die Datenanalyse.' }],
    company: { name: 'Example AG' },
    location: { city: 'Zürich', postalCode: '8001', cantonCode: 'ZH' },
    languageSkills: [{ languageIsoCode: 'en', spokenLevel: 'PROFICIENT', writtenLevel: 'PROFICIENT' }],
  },
};

test('maps a Job-Room advertisement to a parsed job and strips search highlighting', () => {
  const parsed = advertisementToParsedJob(advertisement);
  assert.equal(parsed?.title, 'Data Analyst');
  assert.equal(parsed?.company, 'Example AG');
  assert.equal(parsed?.location, 'Zürich 8001 ZH');
  assert.equal(parsed?.sourceUrl, 'https://www.job-room.ch/job-search/d483da4d-c4dc-4b17-bbf2-15edcf5f0fcd');
  assert.equal(parsed?.postedAt, '2026-08-27');
  assert.equal(parsed?.languageSkills.length, 1);
});

test('prefers an English description when the advertisement publishes one', () => {
  const parsed = advertisementToParsedJob({
    ...advertisement,
    jobContent: {
      ...advertisement.jobContent,
      jobDescriptions: [
        { languageIsoCode: 'de', title: 'Datenanalyst', description: 'Deutsche Beschreibung.' },
        { languageIsoCode: 'en', title: 'Data Analyst', description: 'English description.' },
      ],
    },
  });
  assert.equal(parsed?.title, 'Data Analyst');
  assert.equal(parsed?.descriptionHtml, 'English description.');
});

test('skips advertisements without a usable title or description', () => {
  assert.equal(advertisementToParsedJob({ id: 'x', jobContent: { jobDescriptions: [] } }), null);
  assert.equal(advertisementToParsedJob({ jobContent: advertisement.jobContent }), null);
});

test('treats a Job-Room job URL as a Swiss source with a stable id', () => {
  const url = 'https://www.job-room.ch/job-search/d483da4d-c4dc-4b17-bbf2-15edcf5f0fcd';
  assert.equal(sourceJobIdFromUrl(url), 'd483da4d-c4dc-4b17-bbf2-15edcf5f0fcd');
  assert.equal(sourceInfoForUrl(url).key, 'job-room.ch');
  assert.equal(sourceInfoForUrl(url).country, 'switzerland');
});

test('blocks employer-declared local language at working level', () => {
  const result = analyzeStructuredLanguages([
    { languageIsoCode: 'de', spokenLevel: 'PROFICIENT', writtenLevel: 'PROFICIENT' },
    { languageIsoCode: 'en', spokenLevel: 'INTERMEDIATE', writtenLevel: 'INTERMEDIATE' },
  ]);
  assert.equal(result?.status, 'blocked');
  assert.match(result!.summary, /German/);
});

test('passes when English is required and local languages stay basic', () => {
  const result = analyzeStructuredLanguages([
    { languageIsoCode: 'en', spokenLevel: 'PROFICIENT', writtenLevel: 'PROFICIENT' },
    { languageIsoCode: 'fr', spokenLevel: 'BASIC', writtenLevel: 'BASIC' },
  ]);
  assert.equal(result?.status, 'pass');
});

test('reviews when no local language is required but English is not declared either', () => {
  const result = analyzeStructuredLanguages([{ languageIsoCode: 'fr', spokenLevel: 'BASIC', writtenLevel: null }]);
  assert.equal(result?.status, 'review');
});

test('falls back to prose analysis when nothing is declared', () => {
  assert.equal(analyzeStructuredLanguages([]), null);
  assert.equal(analyzeStructuredLanguages([{ languageIsoCode: 'de', spokenLevel: 'NONE', writtenLevel: 'NONE' }]), null);
});
