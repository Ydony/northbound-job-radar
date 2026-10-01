import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dataMinimizationNotes,
  logHygieneTable,
  processorTable,
  retentionTable,
  RETENTION_REVIEW_STATUS,
} from '../lib/retention-review';
import * as privacyPolicy from '../lib/privacy-policy';

/**
 * T38 (F13): the retention/processor tables are a review packet, not enforcement.
 * These tests pin that boundary: no row may claim to be enforced, every F13
 * category must be present, undecided regions must say so, and the privacy
 * notice must not quote a proposed period as if the code already ran it.
 */

test('every retention row is proposed, never enforced', () => {
  assert.ok(retentionTable.length >= 8, 'the table shrank below the F13 categories');
  for (const row of retentionTable) {
    assert.equal(row.status, RETENTION_REVIEW_STATUS, `${row.category} is not marked proposed`);
    assert.doesNotMatch(row.status, /enforced|implemented|active/i);
  }
});

test('the retention table covers accounts, searches, logs, tokens and backups', () => {
  const blob = JSON.stringify(retentionTable).toLowerCase();
  for (const keyword of [
    'accounts', 'search_runs', 'auth_events', 'rate_limits', 'email_verifications',
    'password_resets', 'session', 'daily_visits', 'visit_markers', 'backup',
  ]) {
    assert.ok(blob.includes(keyword), `retention table never mentions ${keyword}`);
  }
});

test('undecided processor regions say so instead of implying a decision', () => {
  assert.ok(processorTable.length >= 6, 'the processor table shrank');
  for (const row of processorTable) {
    for (const field of [row.recipient, row.purpose, row.dataSent, row.region, row.status]) {
      assert.ok(field.length > 0, 'a processor row has an empty field');
    }
    if (/TBD|undecided/i.test(row.region)) {
      assert.match(row.status, /proposed|undecided|confirm|gated/i,
        `${row.recipient}: undecided region is not marked as undecided in its status`);
    }
  }
});

test('the processor table names hosting, mail, backup, bot-check, sources and the AI negative', () => {
  const blob = JSON.stringify(processorTable).toLowerCase();
  for (const keyword of ['cloudflare', 'resend', 'turnstile', 'backup', 'job sources', 'no ai']) {
    assert.ok(blob.includes(keyword), `processor table never mentions ${keyword}`);
  }
});

test('log-hygiene claims each carry checkable evidence', () => {
  assert.ok(logHygieneTable.length >= 5, 'log hygiene lost rows');
  for (const row of logHygieneTable) {
    assert.ok(row.claim.length > 0 && row.evidence.length > 0, 'a log-hygiene row is empty');
  }
  const blob = JSON.stringify(logHygieneTable).toLowerCase();
  for (const keyword of ['password', 'token', 'auth_events', 'turnstile']) {
    assert.ok(blob.includes(keyword), `log hygiene never mentions ${keyword}`);
  }
});

test('data minimisation states the AI/model boundary explicitly', () => {
  const blob = dataMinimizationNotes.join(' ');
  assert.match(blob, /AI services|model providers/i);
});

test('the privacy notice discloses review status instead of promising schedules', () => {
  assert.match(privacyPolicy.retentionReviewNote.body, /not enforced|does not run|waiting/i);
});

test('the privacy notice quotes no proposed retention period as current behaviour', () => {
  const notice = JSON.stringify(privacyPolicy);
  for (const row of retentionTable) {
    assert.ok(!notice.includes(row.proposedPeriod),
      `privacy notice quotes the proposed period for: ${row.category}`);
  }
});
