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
