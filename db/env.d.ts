declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    /** Optional free aggregator credentials; the matching sources stay unavailable until these are set. */
    ADZUNA_APP_ID?: string;
    ADZUNA_APP_KEY?: string;
    CAREERJET_API_KEY?: string;
    /** Must match the website registered with Careerjet; they enforce it via the Referer header. */
    CAREERJET_REFERER?: string;
    CAREERJET_USER_IP?: string;
    /** PBKDF2 hash from . Without it every route refuses to serve. */
    APP_PASSWORD_HASH?: string;
    /** Random secret signing session cookies. Rotating it signs everyone out. */
    SESSION_SECRET?: string;
    /** 'true' opens registration beyond the first account. Closed by default so a public deployment cannot be signed up to by strangers. */
    ALLOW_SIGNUPS?: string;
    /** Set only by the VPN-enforced launcher, after it verifies a full tunnel route. Without it the restricted sources refuse to run. */
    VPN_ENFORCED?: string;
    INDEED_ENABLED?: string;
    INDEED_LOCAL_ONLY?: string;
    INDEED_APP_IDENTITY_APPROVED?: string;
    INDEED_API_KEY?: string;
    INDEED_USER_AGENT?: string;
    INDEED_APP_INFO?: string;
    /**
     * Native edge rate limiter for auth endpoints (#171). Optional: without the `ratelimits`
     * configuration the app relies on the database limiter alone.
     *
     * VPS-05 (#198): Cloudflare-only by design and kept until cutover (#201). The self-hosted
     * path never sets this — `bindings()` in db/runtime.ts returns no authRateLimiter there,
     * `nativeRateLimit` no-ops on the missing binding, and the database limiter plus nginx
     * `limit_req` (deploy/nginx-ikbeneenappel.conf) carry the whole job.
     */
    AUTH_RATE_LIMIT?: RateLimit;
    /** Public Turnstile sitekey served to the registration form; safe to configure as plain text. */
    TURNSTILE_SITE_KEY?: string;
    /** Turnstile secret key. Owner-set via `wrangler secret put`, never committed. */
    TURNSTILE_SECRET_KEY?: string;
    /**
     * Resend key for verification and password-reset emails. Real secret: the owner sets it
     * with `wrangler secret put RESEND_API_KEY` — never in chat, code, or a worker prompt.
     * Unset locally, where tests run against a mocked endpoint instead.
     */
    RESEND_API_KEY?: string;
    /** Sender shown on verification and reset emails, e.g. 'Ik ben een appel <noreply@example.com>'. */
    RESEND_FROM?: string;
    /**
     * INT-06 (#165) bounded public refresh. Exactly 'true' lets the cron
     * handler run; anything else (including unset) is a no-op. Prod-only and
     * owner-supervised; never set in dev/test.
     */
    PUBLIC_REFRESH_ENABLED?: string;
    /**
     * Comma-separated role keywords the public refresh searches (e.g.
     * 'engineer,analyst'). Empty wires no fetchers: the run keeps locks and
     * freshness truthful but contacts no upstream source.
     */
    PUBLIC_REFRESH_TERMS?: string;
    /**
     * Self-hosted SQLite file (VPS-02, #195). Absent on Cloudflare, where DB is a real binding.
     */
    SQLITE_PATH?: string;
    /**
     * Database encryption key injection (F11, T30). Inline key material: prefer
     * SQLITE_KEY_FILE. Fail-closed via `DB_ENCRYPTION_REQUIRED`; refused
     * outright until the owner-selected cipher driver lands (see
     * `db/encryption.ts`). Never commit a real value.
     */
    SQLITE_KEY?: string;
    /** Path to a root-owned 0600 file holding the database key. Preferred over SQLITE_KEY. */
    SQLITE_KEY_FILE?: string;
    /**
     * Exactly 'true' refuses to boot the self-hosted database without a key.
     * Anything else (including unset) keeps the plaintext dev/test posture.
     */
    DB_ENCRYPTION_REQUIRED?: string;
  }
}
