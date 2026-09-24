import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('job-card updates bind the authenticated owner for every scoped mutation', async () => {
  const source = await readFile(new URL('../app/api/jobs/[id]/route.ts', import.meta.url), 'utf8');
  assert.match(source, /is_saved = \?, updated_at = \? WHERE id = \? AND user_id = \?'\)\s*\n\s*\.bind\(body\.isSaved \? 1 : 0, now, id, user\.id\)/);
  assert.match(source, /application_status = \?, updated_at = \? WHERE id = \? AND user_id = \?'\)\s*\n\s*\.bind\(applicationStatus, now, id, user\.id\)/);
  assert.match(source, /visibility_status = \?, updated_at = \? WHERE id = \? AND user_id = \?'\)\s*\n\s*\.bind\(visibilityStatus, now, id, user\.id\)/);
  assert.match(source, /END WHERE id = \? AND user_id = \?`\)\.bind\(id, user\.id\)/);
});

test('reading corrections back cannot disclose a private source after demotion', async () => {
  // Found while reviewing the paused Indeed draft: /api/feedback exported every correction this
  // account had made, joined to its jobs, with no source filter at all. /api/state hides
  // page-fetching sources from an ordinary account, so an account demoted from administrator kept
  // a second way to read back their names, titles and stored evidence — and ordinary accounts must
  // never learn those sources exist. Both guards are asserted here because a filter applied after
  // the query would still fetch the rows, and the LIMIT would still be spent on them.
  // Since INT-02 the exclusion lives in the shared audienceExclusionClause (lib/server-data.ts),
  // derived from the registry-driven adminOnlySourceKeys — pinned here rather than restated.
  const source = await readFile(new URL('../app/api/feedback/route.ts', import.meta.url), 'utf8');
  assert.match(source, /adminOnlySourceKeys/, 'the export must derive the hidden keys, not restate them');
  assert.match(source, /user\.role === 'admin' \? \[\] : \[\.\.\.adminOnlySourceKeys\(\)\]/);
  assert.match(source, /audienceExclusionClause\('j', hiddenSourceKeys\)/,
    'the export must share the audience predicate, not a local split');
  assert.match(source, /audience\.clause\} ORDER BY f\.updated_at DESC LIMIT 500/,
    'hidden sources must be excluded in SQL, before the LIMIT');
  const predicate = await readFile(new URL('../lib/server-data.ts', import.meta.url), 'utf8');
  assert.match(predicate, /source_key NOT IN/, 'the shared predicate must exclude hidden keys in SQL');
  assert.match(predicate, /indeedSql\(tableAlias\)/, 'the shared predicate must cover legacy Indeed rows by URL');
  assert.match(source, /JOIN jobs j ON j\.id = f\.job_id AND j\.user_id = f\.user_id/,
    'the join must carry the owner too, so a correction can never reach another account\u2019s job row');
});
