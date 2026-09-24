import { emailConfiguration, ensureSchema } from '@/db/runtime';
import { emailConfigured, sendEmailViaResend, type OutgoingEmail } from '@/lib/email';
import { clientIp, durableRateLimit, requireSession } from '@/lib/guard';
import { isValidEmail, normalizeEmail } from '@/lib/users';

/**
 * Email delivery diagnostics, administrator only.
 *
 * Every other path deliberately throws the reason away. `POST /api/auth/password-reset`
 * answers identically whether or not the address exists, so it cannot report that Resend
 * refused the message; registration returns a bare `verificationEmailSent: false`. That is
 * right for a stranger and useless for the owner, who otherwise pastes a key, receives
 * nothing, and has no way to tell an unverified sending domain from a wrong key.
 *
 * `GET` reports configuration without disclosing it: whether a key is present, never the
 * key. `POST` sends one real message and returns Resend's own refusal verbatim — which is
 * where the answer actually lives ("domain is not verified", "API key is invalid").
 *
 * Both are behind the administrator guard, so the detail that is withheld from the public
 * routes is safe here: the only person who can read it already runs the installation.
 */

const RECENT_WINDOW_HOURS = 24;

export async function GET(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request, { adminOnly: true });
  if (response) return response;
  const { db } = session;
  const config = emailConfiguration();

  // Outcomes are recorded as auth_events kinds by the sending routes. The table carries no
  // detail column, so this says how often delivery failed, not why; `POST` answers why.
  const since = new Date(Date.now() - RECENT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const counts = await db.prepare(`SELECT kind, COUNT(*) AS total FROM auth_events
    WHERE created_at >= ? AND kind IN ('email-sent', 'email-failed') GROUP BY kind`)
    .bind(since).all<{ kind: string; total: number }>();
  const tally = (kind: string) => counts.results.find((row) => row.kind === kind)?.total ?? 0;

  return Response.json({
    configured: emailConfigured(config),
    // The sender is not a secret — it appears in the From line of every message sent.
    from: config.from,
    // Never the key itself, and never its length or prefix: presence is all that is useful.
    apiKeyPresent: config.apiKey !== '',
    recent: {
      windowHours: RECENT_WINDOW_HOURS,
      sent: tally('email-sent'),
      failed: tally('email-failed'),
    },
    // What is still missing, in the order it has to be done.
    missing: [
      ...(config.apiKey === '' ? ['RESEND_API_KEY is not set (owner-set via `wrangler secret put`).'] : []),
      ...(config.from === '' ? ['RESEND_FROM is not set, e.g. "Ik ben een appel <noreply@ikbeneenappel.nl>".'] : []),
    ],
  });
}

/**
 * Sends one real message to an address the administrator names, and reports what happened.
 *
 * Deliberately a real send rather than a dry run: everything this needs to prove — that the
 * key is accepted, that the sending domain is verified, that the From address is one Resend
 * will accept — is only knowable by asking Resend to send something.
 */
export async function POST(request: Request) {
  await ensureSchema();
  const { session, response } = await requireSession(request, { adminOnly: true });
  if (response) return response;
  const { db } = session;
  const ip = clientIp(request);

  // An administrator can still fat-finger a loop. Resend's own quota is not the thing to
  // discover that with.
  const limited = await durableRateLimit(db, `email-test:ip:${ip}`, 10, 15 * 60_000);
  if (limited) return limited;

  const body = await request.json().catch(() => ({})) as { to?: unknown };
  const to = normalizeEmail(body.to);
  if (!isValidEmail(to)) {
    return Response.json({ error: 'Give a valid address to send the test to.' }, { status: 400 });
  }

  const config = emailConfiguration();
  if (!emailConfigured(config)) {
    return Response.json({
      error: 'Email is not configured on this installation.',
      missing: [
        ...(config.apiKey === '' ? ['RESEND_API_KEY'] : []),
        ...(config.from === '' ? ['RESEND_FROM'] : []),
      ],
    }, { status: 503 });
  }

  const stamp = new Date().toISOString();
  const message: OutgoingEmail = {
    to,
    subject: 'Test message from Ik ben een appel',
    text: `This is a test message, sent from the administration screen at ${stamp}.\n\n`
      + 'It proves three things at once: the Resend key is accepted, the sending domain is '
      + 'verified, and the From address is one Resend will send as. If you are reading it, '
      + 'verification and password-reset messages will arrive the same way.\n\n'
      + 'Nobody asked you to do anything. There is no link to click.',
    html: '<p>This is a test message, sent from the administration screen at '
      + `${stamp}.</p><p>It proves three things at once: the Resend key is accepted, the `
      + 'sending domain is verified, and the From address is one Resend will send as. If you '
      + 'are reading it, verification and password-reset messages will arrive the same way.</p>'
      + '<p>Nobody asked you to do anything. There is no link to click.</p>',
  };

  const result = await sendEmailViaResend(config, message);
  await db.prepare('INSERT INTO auth_events (id, email, ip, kind, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), to, ip, result.sent ? 'email-sent' : 'email-failed', stamp).run();

  // Resend's refusal is the diagnosis, and it is returned whole. Administrator-only, so the
  // detail that the public routes must never disclose is safe to read here.
  return Response.json({
    sent: result.sent,
    to,
    from: config.from,
    ...(result.id ? { providerId: result.id } : {}),
    ...(result.error ? { error: result.error } : {}),
  }, { status: result.sent ? 200 : 502 });
}
