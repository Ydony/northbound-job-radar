import { NextResponse } from 'next/server';
import { bindings, ensureSchema } from '@/db/runtime';
import { roleForSlot } from '@/lib/criteria';
import { criteriaFromRow, rescoreAllJobs, type CriteriaRow } from '@/lib/server-data';
import type { ContractType, CvSlot, Seniority, WorkplaceMode } from '@/lib/types';

const workplaces = new Set<WorkplaceMode>(['any', 'remote', 'hybrid', 'onsite']);
const seniorities = new Set<Seniority>(['any', 'internship', 'entry', 'mid', 'senior', 'lead']);
const contractTypes = new Set<ContractType>(['any', 'permanent', 'temporary', 'contract', 'internship']);

function cleanText(value: unknown, max = 160) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function cleanKeywords(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, 60).toLowerCase()).filter(Boolean))].slice(0, 20);
}

export async function PUT(request: Request) {
  await ensureSchema();
  const body = await request.json() as Record<string, unknown>;
  const workplace = cleanText(body.workplace) as WorkplaceMode;
  const seniority = cleanText(body.seniority) as Seniority;
  const contractType = cleanText(body.contractType) as ContractType;
  if (!workplaces.has(workplace) || !seniorities.has(seniority) || !contractTypes.has(contractType)) {
    return NextResponse.json({ error: 'One or more search filters are invalid.' }, { status: 400 });
  }

  const input = {
    roleOverrideA: cleanText(body.roleOverrideA),
    roleOverrideB: cleanText(body.roleOverrideB),
    location: cleanText(body.location),
    workplace,
    seniority,
    contractType,
    requiredKeywords: cleanKeywords(body.requiredKeywords),
    excludedKeywords: cleanKeywords(body.excludedKeywords),
  };
  const now = new Date().toISOString();
  const { db } = bindings();
  await db.prepare(`INSERT INTO search_settings (id, role_override_a, role_override_b, location, workplace,
      seniority, contract_type, required_keywords, excluded_keywords, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET role_override_a = excluded.role_override_a,
      role_override_b = excluded.role_override_b, location = excluded.location, workplace = excluded.workplace,
      seniority = excluded.seniority, contract_type = excluded.contract_type,
      required_keywords = excluded.required_keywords, excluded_keywords = excluded.excluded_keywords,
      updated_at = excluded.updated_at`)
    .bind('default', input.roleOverrideA, input.roleOverrideB, input.location, input.workplace, input.seniority,
      input.contractType, JSON.stringify(input.requiredKeywords), JSON.stringify(input.excludedKeywords), now).run();
  const row = await db.prepare('SELECT * FROM search_settings WHERE id = ?').bind('default').first<CriteriaRow>();
  const criteria = criteriaFromRow(row);
  const cvRows = await db.prepare('SELECT slot, cv_text, derived_role FROM cvs')
    .all<{ slot: CvSlot; cv_text: string; derived_role: string }>();
  const rescoredJobs = await rescoreAllJobs(db, cvRows.results.map((saved) => ({
    slot: saved.slot,
    cvText: saved.cv_text,
    derivedRole: roleForSlot(saved.slot, saved.derived_role, criteria),
  })));
  return NextResponse.json({ criteria, rescoredJobs });
}
