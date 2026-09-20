import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exportStateLeaksPrivateFields,
  isAllowedSecondaryImportStatus,
  isLocalVerifyHostname,
  isStaleSessionRevoked,
  parseVerifierPayload,
  sameUrlIsolatedPerOwner,
} from '../scripts/verify-dev-workflow.mjs';

/**
 * #85: the local verification harness failed on a working app — twice — because nothing tested
 * its own assumptions. These tests check the harness logic without needing a live server: feed
 * it recorded bodies and assert what it returns.
 */

const NDJSON_TYPE = 'application/x-ndjson; charset=utf-8';

function ndjsonBody(lines: Array<unknown | string>): string {
  return `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`;
}

test('NDJSON progress events followed by a result returns the result, not the string', () => {
  const result = { run: { sources: [{ key: 'job-room', status: 'complete' }] } };
  const body = ndjsonBody([
    { type: 'progress', label: 'Contacting 3 sources…', percent: 10, step: 1, steps: 4 },
    { type: 'progress', label: 'Screening job-room…', percent: 70, step: 3, steps: 4 },
    result,
  ]);
  const parsed = parseVerifierPayload(NDJSON_TYPE, body) as typeof result;
  assert.deepEqual(parsed, result);
  assert.ok(typeof parsed !== 'string' && Array.isArray(parsed.run.sources));
});

test('NDJSON keeps the last non-progress event when several results arrive', () => {
  const body = ndjsonBody([
    { type: 'progress', label: 'Working…', percent: 5, step: 1, steps: 2 },
    { run: { sources: [] }, stale: true },
    { run: { sources: [{ key: 'job-room', status: 'complete' }] } },
  ]);
  const parsed = parseVerifierPayload(NDJSON_TYPE, body) as { stale?: boolean; run: { sources: unknown[] } };
  assert.equal(parsed.stale, undefined);
  assert.equal(parsed.run.sources.length, 1);
});

test('plain JSON bodies still parse as JSON', () => {
  const parsed = parseVerifierPayload('application/json', JSON.stringify({ role: 'user' })) as { role: string };
  assert.equal(parsed.role, 'user');
});

test('JSON with a charset suffix still parses as JSON', () => {
  const parsed = parseVerifierPayload(
    'application/json; charset=utf-8',
    JSON.stringify({ criteria: { roleKeywords: ['a', 'b', 'c'] } }),
  ) as { criteria: { roleKeywords: string[] } };
  assert.deepEqual(parsed.criteria.roleKeywords, ['a', 'b', 'c']);
});

test('a truncated NDJSON final line does not throw and keeps the last good result', () => {
  const result = { run: { sources: [{ key: 'job-room', status: 'complete' }] } };
  const body = `${ndjsonBody([{ type: 'progress', label: 'Working…', percent: 5, step: 1, steps: 2 }, result])}{"run": {"sources": [`;
  const parsed = parseVerifierPayload(NDJSON_TYPE, body) as typeof result;
  assert.deepEqual(parsed, result);
});

test('NDJSON with only progress events returns an empty result rather than a string', () => {
  const body = ndjsonBody([{ type: 'progress', label: 'Working…', percent: 5, step: 1, steps: 2 }]);
  assert.deepEqual(parseVerifierPayload(NDJSON_TYPE, body), {});
});

test('NDJSON ignores blank lines between events', () => {
  const result = { run: { sources: [] } };
  const body = `\n${JSON.stringify({ type: 'progress', label: 'Working…' })}\n\n${JSON.stringify(result)}\n\n`;
  assert.deepEqual(parseVerifierPayload(NDJSON_TYPE, body), result);
});

test('non-JSON pages come back as text', () => {
  const html = '<!DOCTYPE html><html><body>ok</body></html>';
  assert.equal(parseVerifierPayload('text/html; charset=utf-8', html), html);
});

test('malformed JSON fails loudly instead of passing silently', () => {
  assert.throws(() => parseVerifierPayload('application/json', '{not json'));
});

test('importing without a CV accepts either shelved-gate answer, nothing else', () => {
  // The CV gate is shelved (CV_MATCHING_ENABLED = false): 200 means the import was allowed,
  // 400 means a gate still refused it. Both are correct behaviour; anything else is a real error.
  assert.equal(isAllowedSecondaryImportStatus(200), true);
  assert.equal(isAllowedSecondaryImportStatus(400), true);
  assert.equal(isAllowedSecondaryImportStatus(401), false);
  assert.equal(isAllowedSecondaryImportStatus(404), false);
  assert.equal(isAllowedSecondaryImportStatus(500), false);
});

test('per-owner isolation needs two distinct job ids', () => {
  assert.equal(sameUrlIsolatedPerOwner('job-a', 'job-b'), true);
  assert.equal(sameUrlIsolatedPerOwner('job-a', 'job-a'), false);
  assert.equal(sameUrlIsolatedPerOwner('job-a', ''), false);
  assert.equal(sameUrlIsolatedPerOwner('job-a', undefined), false);
  assert.equal(sameUrlIsolatedPerOwner('', ''), false);
});

test('export state leaks when CV text or the file key is present', () => {
  assert.equal(exportStateLeaksPrivateFields(JSON.stringify({ jobs: [] })), false);
  assert.equal(exportStateLeaksPrivateFields(JSON.stringify({ cvText: 'secret' })), true);
  assert.equal(exportStateLeaksPrivateFields(JSON.stringify({ objectKey: 'cvs/1/a' })), true);
});

test('a stale session after credential change must be exactly 401', () => {
  assert.equal(isStaleSessionRevoked(401), true);
  assert.equal(isStaleSessionRevoked(403), false);
  assert.equal(isStaleSessionRevoked(200), false);
});

test('the verifier only targets loopback hosts', () => {
  assert.equal(isLocalVerifyHostname('localhost'), true);
  assert.equal(isLocalVerifyHostname('127.0.0.1'), true);
  assert.equal(isLocalVerifyHostname('::1'), true);
  assert.equal(isLocalVerifyHostname('example.com'), false);
  assert.equal(isLocalVerifyHostname(''), false);
});
