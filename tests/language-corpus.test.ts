import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLanguage } from '../lib/analysis';
import { languageCorpus } from './fixtures/language-corpus';

/**
 * Measures the language gate against a labelled corpus, rather than asserting one rule at a time.
 *
 * The per-rule tests in `analysis.test.ts` say a given phrase is handled. They cannot say whether
 * the gate as a whole is getting better or worse, which is the only question that matters for a
 * product whose entire claim is "English is enough here". This file answers that, and fails on the
 * one error the product cannot absorb.
 */

function verdicts() {
  return languageCorpus.map((entry) => ({
    ...entry,
    actual: analyzeLanguage(entry.description, entry.title).status,
  }));
}

test('no advertisement requiring a local language is ever passed as English', () => {
  // The asymmetry is deliberate and is the product's central promise. Over-blocking costs a job.
  // A false pass costs an application written for a role that was never open to you, and it is
  // the failure docs/ACCEPTANCE_TEST.md calls the most serious this app can have.
  const falsePasses = verdicts().filter(
    (entry) => entry.expected === 'blocked' && entry.actual === 'pass',
  );
  assert.deepEqual(
    falsePasses.map((entry) => `${entry.id} (${entry.tests})`),
    [],
    'an advertisement that requires a local language was reported as English-sufficient',
  );
});

test('every corpus case receives the verdict it is labelled with', () => {
  const wrong = verdicts()
    .filter((entry) => entry.actual !== entry.expected)
    .map((entry) => `${entry.id}: expected ${entry.expected}, got ${entry.actual} — ${entry.tests}`);
  assert.deepEqual(wrong, [], `${wrong.length} of ${languageCorpus.length} cases disagree`);
});

test('a confirmed pass is never given on an advertisement too short to judge', () => {
  // The 84%-of-verdicts-resting-on-teasers problem, pinned. A short ad may be 'unknown'; it may
  // never be 'pass', whatever its prose looks like.
  const shortPasses = verdicts().filter(
    (entry) => entry.description.trim().length < 900 && entry.actual === 'pass',
  );
  assert.deepEqual(shortPasses.map((entry) => entry.id), []);
});

test('the corpus covers every verdict the gate can return', () => {
  // A corpus that only contains the cases we already handle measures nothing. This fails if a
  // verdict stops being represented, which is how a corpus quietly rots into a formality.
  const covered = new Set(languageCorpus.map((entry) => entry.expected));
  for (const status of ['pass', 'review', 'unknown', 'blocked']) {
    assert.ok(covered.has(status as never), `the corpus has no ${status} case`);
  }
});
