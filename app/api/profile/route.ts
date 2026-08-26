import { NextResponse } from 'next/server';
import { bindings, ensureSchema } from '@/db/runtime';
import { deriveRoleFromCv } from '@/lib/role-detection';
import { cvFromRow, rescoreAllJobs, type CvRow } from '@/lib/server-data';
import type { CvSlot } from '@/lib/types';

const maxCvBytes = 10 * 1024 * 1024;
const allowedExtensions = new Set(['pdf', 'docx', 'txt']);
const slots = new Set<CvSlot>(['a', 'b']);

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-100) || 'cv';
}

export async function POST(request: Request) {
  await ensureSchema();
  const form = await request.formData();
  const slot = String(form.get('slot') ?? '') as CvSlot;
  const cvText = String(form.get('cvText') ?? '').trim().slice(0, 250_000);
  const fileEntry = form.get('file');
  const file = fileEntry instanceof File && fileEntry.size > 0 ? fileEntry : null;

  if (!slots.has(slot)) return NextResponse.json({ error: 'Invalid CV slot.' }, { status: 400 });
  if (!file) return NextResponse.json({ error: 'Choose a CV file.' }, { status: 400 });
  if (file.size > maxCvBytes) return NextResponse.json({ error: 'CV must be 10 MB or smaller.' }, { status: 400 });
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!allowedExtensions.has(extension)) return NextResponse.json({ error: 'Use a PDF, DOCX, or TXT file.' }, { status: 400 });
  if (cvText.length < 80) return NextResponse.json({ error: 'I could not read enough text from this CV. Try another file or a text-based PDF.' }, { status: 400 });

  const derivedRole = deriveRoleFromCv(cvText);
  const { db, files } = bindings();
  const previous = await db.prepare('SELECT object_key FROM cvs WHERE slot = ?').bind(slot).first<{ object_key: string }>();
  const objectKey = `cv/${slot}/${Date.now()}-${safeFileName(file.name)}`;
  await files.put(objectKey, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
    customMetadata: { originalName: file.name },
  });
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO cvs (id, slot, file_name, object_key, cv_text, derived_role, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot) DO UPDATE SET file_name = excluded.file_name, object_key = excluded.object_key,
      cv_text = excluded.cv_text, derived_role = excluded.derived_role, updated_at = excluded.updated_at`)
    .bind(crypto.randomUUID(), slot, file.name, objectKey, cvText, derivedRole, now).run();
  if (previous?.object_key && previous.object_key !== objectKey) await files.delete(previous.object_key);

  const allCvs = await db.prepare('SELECT slot, cv_text, derived_role FROM cvs')
    .all<{ slot: CvSlot; cv_text: string; derived_role: string }>();
  const rescoredJobs = await rescoreAllJobs(db, allCvs.results.map((saved) => ({
    slot: saved.slot,
    cvText: saved.cv_text,
    derivedRole: saved.derived_role,
  })));

  const row = await db.prepare('SELECT * FROM cvs WHERE slot = ?').bind(slot).first<CvRow>();
  return NextResponse.json({ cv: cvFromRow(row!), rescoredJobs });
}
