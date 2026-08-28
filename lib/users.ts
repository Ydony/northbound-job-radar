import { hashPassword, verifyPassword } from './auth';

export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';

export interface UserRecord {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastSeenAt: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  last_seen_at: string;
}

export function userFromRow(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status === 'disabled' ? 'disabled' : 'active',
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function normalizeEmail(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase().slice(0, 254) : '';
}

export function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

/** Long over complex: length is what actually resists guessing, and arbitrary character classes push people toward reused passwords. */
export function passwordProblem(password: string) {
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 200) return 'That password is too long.';
  if (/^\s|\s$/.test(password)) return 'Remove leading or trailing spaces.';
  return '';
}

export async function findUserByEmail(db: D1Database, email: string) {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();
}

export async function findUserById(db: D1Database, id: string) {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export async function countUsers(db: D1Database) {
  const row = await db.prepare('SELECT COUNT(*) AS total FROM users').first<{ total: number }>();
  return row?.total ?? 0;
}

export interface CreatedUser {
  user: UserRecord;
  claimedLegacyWorkspace: boolean;
}

/**
 * Creates an account. The first account becomes the admin and adopts any pre-existing single-user
 * data, so upgrading an existing installation does not strand the workspace behind a login it can
 * no longer reach. Every later account starts empty.
 */
export async function createUser(db: D1Database, email: string, password: string, now = new Date().toISOString()): Promise<CreatedUser> {
  const isFirst = await countUsers(db) === 0;
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO users (id, email, password_hash, role, status, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)`)
    .bind(id, email, await hashPassword(password), isFirst ? 'admin' : 'user', now, now).run();

  if (isFirst) {
    await db.batch([
      db.prepare("UPDATE cvs SET user_id = ? WHERE user_id = 'legacy'").bind(id),
      db.prepare("UPDATE jobs SET user_id = ? WHERE user_id = 'legacy'").bind(id),
      db.prepare("UPDATE search_settings SET user_id = ? WHERE user_id = 'legacy'").bind(id),
      db.prepare("UPDATE search_roles SET user_id = ? WHERE user_id = 'legacy'").bind(id),
      db.prepare("UPDATE language_feedback SET user_id = ? WHERE user_id = 'legacy'").bind(id),
      db.prepare("UPDATE dismissed_jobs SET user_id = ? WHERE user_id = 'legacy'").bind(id),
      db.prepare("UPDATE search_runs SET user_id = ? WHERE user_id = 'legacy'").bind(id),
    ]);
  }

  const row = await findUserById(db, id);
  return { user: userFromRow(row!), claimedLegacyWorkspace: isFirst };
}

/**
 * Verifies a sign-in. A missing account still runs a hash comparison so the response time does not
 * reveal which addresses are registered.
 */
export async function authenticate(db: D1Database, email: string, password: string) {
  const row = await findUserByEmail(db, email);
  const storedHash = row?.password_hash
    ?? 'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const matches = await verifyPassword(password, storedHash);
  if (!row || !matches || row.status !== 'active') return null;
  return userFromRow(row);
}

export async function touchLastSeen(db: D1Database, id: string, now = new Date().toISOString()) {
  await db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, id).run();
}

export async function listUsers(db: D1Database) {
  const rows = await db.prepare('SELECT * FROM users ORDER BY created_at').all<UserRow>();
  return rows.results.map(userFromRow);
}
