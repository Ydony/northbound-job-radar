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
     */
    AUTH_RATE_LIMIT?: RateLimit;
    /** Public Turnstile sitekey served to the registration form; safe to configure as plain text. */
    TURNSTILE_SITE_KEY?: string;
    /** Turnstile secret key. Owner-set via `wrangler secret put`, never committed. */
    TURNSTILE_SECRET_KEY?: string;
  }
}
