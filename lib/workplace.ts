export type WorkplaceType = 'remote' | 'hybrid' | 'onsite' | 'unknown';

/**
 * Order matters. Hybrid is checked before remote and onsite because hybrid ads almost always also
 * mention both, so a plain "remote" match would misread "2 days remote, 3 in the office" as fully
 * remote. Anything without an explicit signal stays `unknown` rather than being guessed at, since a
 * wrong commute assumption wastes an application.
 */
const HYBRID = /\b(?:hybrid|hybride|part(?:ly|ially)[- ]remote|\d\s*(?:-|to|or)?\s*\d?\s*days?\s+(?:per week\s+)?(?:in|at)\s+the\s+office|days?\s+(?:in|at)\s+the\s+office|office\s+days?|mix\s+of\s+(?:home|remote)\s+and\s+office|combination\s+of\s+(?:home|remote)\s+and\s+office)\b/i;
const REMOTE = /\b(?:fully[- ]remote|100%\s*remote|remote[- ]first|work\s+from\s+(?:home|anywhere)|telecommut\w*|home[- ]based|anywhere\s+in\s+(?:europe|the\s+\w+))\b/i;
const ONSITE = /\b(?:on[- ]?site|office[- ]based|no\s+remote|not\s+a\s+remote|100%\s*(?:in\s+the\s+)?office|presence\s+(?:in|at)\s+the\s+office|vor\s+ort)\b/i;

export function detectWorkplaceType(text: string): WorkplaceType {
  if (HYBRID.test(text)) return 'hybrid';
  if (REMOTE.test(text)) return 'remote';
  if (ONSITE.test(text)) return 'onsite';
  return 'unknown';
}

export function workplaceLabel(type: WorkplaceType) {
  if (type === 'remote') return 'Remote';
  if (type === 'hybrid') return 'Hybrid';
  if (type === 'onsite') return 'On-site';
  return 'Work type unknown';
}
