import { NextResponse } from 'next/server';
import { authSecrets, ensureSchema } from '@/db/runtime';
import { hashPassword } from '@/lib/auth';
import { readDailyVisits } from '@/lib/analytics';
import { requireSession } from '@/lib/guard';
import { listUsers, type UserRecord } from '@/lib/users';

export interface AdminOverview {
  users: (UserRecord & { jobCount: number; cvCount: number })[];
  visits: { day: string; totalVisits: number; uniqueVisitors: number }[];
  totals: { users: number; admins: number; jobs: number };
  signupsOpen: boolean;
}

async function activeAdminCount(db: D1Database) {
  const row = await db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'")
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function GET(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request, { adminOnly: true });
  if (response) return response;
  const { db } = session;

  const [users, visits, jobCounts, cvCounts, totals] = await Promise.all([
    listUsers(db),
    readDailyVisits(db, 30),
    db.prepare('SELECT user_id, COUNT(*) AS total FROM jobs GROUP BY user_id').all<{ user_id: string; total: number }>(),
    db.prepare('SELECT user_id, COUNT(*) AS total FROM cvs GROUP BY user_id').all<{ user_id: string; total: number }>(),
    db.prepare('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM jobs) AS jobs')
      .first<{ users: number; jobs: number }>(),
  ]);
  const jobsByUser = new Map(jobCounts.results.map((row) => [row.user_id, row.total]));
  const cvsByUser = new Map(cvCounts.results.map((row) => [row.user_id, row.total]));

  const overview: AdminOverview = {
    // Counts only: an administrator can see that an account exists and how much it holds, never
    // its CV text or its job list.
    users: users.map((user) => ({
      ...user,
      jobCount: jobsByUser.get(user.id) ?? 0,
      cvCount: cvsByUser.get(user.id) ?? 0,
    })),
    visits,
    totals: {
      users: totals?.users ?? 0,
      admins: await activeAdminCount(db),
      jobs: totals?.jobs ?? 0,
    },
    signupsOpen: authSecrets().allowSignups === 'true',
  };
  return NextResponse.json(overview);
}

/** Administrative actions on one account. Guarded so an installation can never lose its last administrator. */
export async function PATCH(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request, { adminOnly: true });
  if (response) return response;
  const { db, user: actor } = session;

  const body = await request.json().catch(() => ({})) as {
    userId?: unknown; action?: unknown; newPassword?: unknown;
  };
  const userId = typeof body.userId === 'string' ? body.userId : '';
  const action = body.action;
  if (!userId) return NextResponse.json({ error: 'Choose an account.' }, { status: 400 });

  const target = await db.prepare('SELECT id, email, role, status FROM users WHERE id = ?').bind(userId)
    .first<{ id: string; email: string; role: string; status: string }>();
  if (!target) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });

  const wouldRemoveLastAdmin = target.role === 'admin' && target.status === 'active'
    && await activeAdminCount(db) <= 1;

  if (action === 'disable') {
    if (target.id === actor.id) return NextResponse.json({ error: 'You cannot disable your own account.' }, { status: 409 });
    if (wouldRemoveLastAdmin) return NextResponse.json({ error: 'That is the only active administrator.' }, { status: 409 });
    await db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(userId).run();
    return NextResponse.json({ ok: true });
  }
  if (action === 'enable') {
    await db.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(userId).run();
    return NextResponse.json({ ok: true });
  }
  if (action === 'promote') {
    await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(userId).run();
    return NextResponse.json({ ok: true });
  }
  if (action === 'demote') {
    if (wouldRemoveLastAdmin) return NextResponse.json({ error: 'That is the only active administrator.' }, { status: 409 });
    await db.prepare("UPDATE users SET role = 'user' WHERE id = ?").bind(userId).run();
    return NextResponse.json({ ok: true });
  }
  if (action === 'set-password') {
    // There is no mail sender here, so a reset is an administrator setting a new password and
    // handing it over directly. The recipient can change it from their own settings afterwards.
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (newPassword.length < 12) return NextResponse.json({ error: 'Use at least 12 characters.' }, { status: 400 });
    await db.batch([
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(newPassword), userId),
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(userId),
    ]);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
}

/** Deletes an account and every row it owns. */
export async function DELETE(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request, { adminOnly: true });
  if (response) return response;
  const { db, user: actor, files } = session;

  const body = await request.json().catch(() => ({})) as { userId?: unknown; confirm?: unknown };
  const userId = typeof body.userId === 'string' ? body.userId : '';
  if (body.confirm !== 'DELETE') return NextResponse.json({ error: 'Deletion was not confirmed.' }, { status: 400 });
  if (userId === actor.id) return NextResponse.json({ error: 'Delete your own account from Settings.' }, { status: 409 });

  const target = await db.prepare('SELECT id, email, role, status FROM users WHERE id = ?').bind(userId)
    .first<{ id: string; email: string; role: string; status: string }>();
  if (!target) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  if (target.role === 'admin' && target.status === 'active' && await activeAdminCount(db) <= 1) {
    return NextResponse.json({ error: 'That is the only active administrator.' }, { status: 409 });
  }

  const cvs = await db.prepare('SELECT object_key FROM cvs WHERE user_id = ?').bind(userId)
    .all<{ object_key: string }>();
  const objectKeys = cvs.results.map((cv) => cv.object_key).filter(Boolean);
  if (objectKeys.length) await files.delete(objectKeys);

  await db.batch([
    db.prepare('DELETE FROM language_feedback WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM jobs WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM cvs WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM search_settings WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM search_roles WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM dismissed_jobs WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM search_run_sources WHERE run_id IN (SELECT id FROM search_runs WHERE user_id = ?)').bind(userId),
    db.prepare('DELETE FROM search_runs WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM auth_events WHERE email = ?').bind(target.email),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
  return NextResponse.json({ ok: true });
}
