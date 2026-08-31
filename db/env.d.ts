declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    CV_FILES: R2Bucket;
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
  }
}
