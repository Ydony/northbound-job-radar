import { NextResponse } from 'next/server';
import { bindings, ensureSchema } from '@/db/runtime';
import type { JobStatus } from '@/lib/types';

const statuses = new Set<JobStatus>(['new', 'saved', 'applied', 'ignored']);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await context.params;
  const body = await request.json() as { status?: JobStatus };
  if (!body.status || !statuses.has(body.status)) return NextResponse.json({ error: 'Invalid job status.' }, { status: 400 });
  const { db } = bindings();
  const result = await db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?')
    .bind(body.status, new Date().toISOString(), id).run();
  if (!result.meta.changes) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await context.params;
  const { db } = bindings();
  await db.prepare('DELETE FROM jobs WHERE id = ?').bind(id).run();
  return NextResponse.json({ ok: true });
}
