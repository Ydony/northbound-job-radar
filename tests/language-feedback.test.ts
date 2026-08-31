import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveLanguageStatus, normalizeLanguageFeedback } from '../lib/language-feedback';

test('keeps the detector status until an explicit incorrect correction exists', () => {
  assert.equal(effectiveLanguageStatus({
    languageStatus: 'review',
    languageFeedback: '',
    correctedLanguageStatus: '',
  }), 'review');
  assert.equal(effectiveLanguageStatus({
    languageStatus: 'review',
    languageFeedback: 'correct',
    correctedLanguageStatus: '',
  }), 'review');
});

test('uses an explicit corrected language status in result views', () => {
  assert.equal(effectiveLanguageStatus({
    languageStatus: 'blocked',
    languageFeedback: 'incorrect',
    correctedLanguageStatus: 'pass',
  }), 'pass');
});

test('normalizes valid feedback and limits its reason', () => {
  assert.deepEqual(normalizeLanguageFeedback('incorrect', 'pass', '  German   is only optional.  '), {
    verdict: 'incorrect',
    correctedStatus: 'pass',
    reason: 'German is only optional.',
  });
  assert.equal(normalizeLanguageFeedback('incorrect', 'pass', 'x'.repeat(600))?.reason.length, 500);
});

test('rejects invalid corrections and supports clearing feedback', () => {
  // 'unknown' used to stand in for an invalid status here; it is a real status now, so the
  // rejection case needs a value that genuinely is not one.
  assert.equal(normalizeLanguageFeedback('incorrect', 'maybe', ''), null);
  assert.equal(normalizeLanguageFeedback('incorrect', 'unknown', '')?.correctedStatus, 'unknown');
  assert.equal(normalizeLanguageFeedback('wrong', 'pass', ''), null);
  assert.deepEqual(normalizeLanguageFeedback('', 'blocked', 'ignored'), {
    verdict: '',
    correctedStatus: '',
    reason: '',
  });
});
