declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    CV_FILES: R2Bucket;
    /** Optional free aggregator credentials; the matching sources stay unavailable until these are set. */
    ADZUNA_APP_ID?: string;
    ADZUNA_APP_KEY?: string;
    CAREERJET_API_KEY?: string;
  }
}
