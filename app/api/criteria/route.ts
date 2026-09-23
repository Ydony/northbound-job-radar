import { ensureSchema } from '@/db/runtime';
import { requireSession } from '@/lib/guard';
import { normalizeRoleKeywords } from '@/lib/criteria';
import { criteriaFromRow, type CriteriaRow, type SearchRoleRow } from '@/lib/server-data';
import type { ContractType, Seniority, WorkplaceMode } from '@/lib/types';

const workplaces = new Set<WorkplaceMode>(['any', 'remote', 'hybrid', 'onsite']);
const seniorities = new Set<Seniority>(['any', 'internship', 'entry', 'mid', 'senior', 'lead']);
const contractTypes = new Set<ContractType>(['any', 'permanent', 'temporary', 'contract', 'internship']);

function cleanText(value: unknown, max = 160) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

// Absent means on, for the same reason the column defaults to 1: an older client that does not
// know about this setting must not silently narrow someone's search to nothing.
function cleanSwitch(value: unknown) {
  return value === undefined || value === null ? true : value !== false;
}

function cleanKeywords(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, 60).toLowerCase()).filter(Boolean))].slice(0, 20);
}

export async function PUT(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request);
  if (response) return response;
  const { db, user } = session;
  const body = await request.json() as Record<string, unknown>;
  // Workplace, seniority and contract type were removed from the product in P5. Their columns are
  // still written so an older client keeps working, but a caller that omits them is not wrong any
  // more - it is simply using the current product, and answering that with "one or more search
  // filters are invalid" describes controls that no longer exist. Missing now means 'any'; a value
  // that is present is still validated, so a malformed one is still refused.
  const workplace = (cleanText(body.workplace) || 'any') as WorkplaceMode;
  const seniority = (cleanText(body.seniority) || 'any') as Seniority;
  const contractType = (cleanText(body.contractType) || 'any') as ContractType;
  if (!workplaces.has(workplace) || !seniorities.has(seniority) || !contractTypes.has(contractType)) {
    return Response.json({ error: 'One or more search filters are invalid.' }, { status: 400 });
  }

  const input = {
    roleKeywords: normalizeRoleKeywords(Array.isArray(body.roleKeywords) ? body.roleKeywords : []),
    location: cleanText(body.location),
    workplace,
    seniority,
    contractType,
    requiredKeywords: cleanKeywords(body.requiredKeywords),
    excludedKeywords: cleanKeywords(body.excludedKeywords),
    searchNetherlands: cleanSwitch(body.searchNetherlands),
    searchSwitzerland: cleanSwitch(body.searchSwitzerland),
  };
  const now = new Date().toISOString();
  const statements = [db.prepare(`INSERT INTO search_settings (id, user_id, location, workplace,
      seniority, contract_type, required_keywords, excluded_keywords, search_netherlands,
      search_switzerland, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET location = excluded.location, workplace = excluded.workplace,
      seniority = excluded.seniority, contract_type = excluded.contract_type,
      required_keywords = excluded.required_keywords, excluded_keywords = excluded.excluded_keywords,
      search_netherlands = excluded.search_netherlands,
      search_switzerland = excluded.search_switzerland,
      updated_at = excluded.updated_at`)
    .bind(`settings:${user.id}`, user.id, input.location, input.workplace, input.seniority,
      input.contractType, JSON.stringify(input.requiredKeywords), JSON.stringify(input.excludedKeywords),
      input.searchNetherlands ? 1 : 0, input.searchSwitzerland ? 1 : 0, now),
    db.prepare('DELETE FROM search_roles WHERE user_id = ?').bind(user.id)];
  input.roleKeywords.forEach((role, position) => statements.push(db.prepare(
    'INSERT INTO search_roles (id, user_id, position, role, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(`${user.id}:${position}`, user.id, position, role, now)));
  await db.batch(statements);
  const [row, roles] = await Promise.all([
    db.prepare('SELECT * FROM search_settings WHERE user_id = ?').bind(user.id).first<CriteriaRow>(),
    db.prepare('SELECT position, role FROM search_roles WHERE user_id = ? ORDER BY position').bind(user.id).all<SearchRoleRow>(),
  ]);
  const criteria = criteriaFromRow(row, roles.results);
  return Response.json({ criteria });
}
