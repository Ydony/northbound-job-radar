const MODIFIERS = ['senior', 'junior', 'lead', 'principal', 'staff', 'chief', 'head', 'associate'];
const TITLE_NOUNS = [
  'engineer', 'developer', 'manager', 'analyst', 'designer', 'architect', 'consultant',
  'specialist', 'coordinator', 'administrator', 'scientist', 'researcher', 'strategist',
  'producer', 'marketer', 'recruiter', 'accountant', 'planner', 'director',
];

/** Words that appear next to a job title in a CV but are never part of one. */
const NOT_TITLE_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'the', 'with', 'for', 'to', 'of', 'in', 'on', 'by', 'from',
  'candidate', 'summary', 'profile', 'experience', 'experienced', 'skills', 'education',
  'name', 'cv', 'resume', 'contact', 'references', 'objective', 'about', 'history',
  'employment', 'current', 'previous', 'present', 'former', 'seeking', 'aspiring', 'am',
]);

const TITLE_NOUN_PATTERN = new RegExp(`\\b(${TITLE_NOUNS.join('|')})\\b`, 'gi');
const WORD_PATTERN = /[a-zA-Z][a-zA-Z+#.-]*/g;

function titleCase(value: string) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Deterministic, local role guess from CV text: no third-party model call (see AGENTS.md).
 *
 * For every title noun ("engineer", "analyst", …) it emits each candidate phrase formed by
 * looking back up to two words, then ranks by frequency. Emitting every length rather than
 * only the longest is what makes this robust: "Software Engineer" recurs across the header,
 * summary, and job history, so it outranks a one-off "Candidate Software Engineer" picked up
 * from a name line. Longer phrases get a small bonus so the specific "software engineer"
 * beats the bare "engineer" they always tie with on frequency.
 */
export function deriveRoleFromCv(cvText: string): string {
  const words = [...cvText.matchAll(WORD_PATTERN)];
  const counts = new Map<string, { count: number; words: number; earliestIndex: number }>();

  for (const [position, word] of words.entries()) {
    if (!TITLE_NOUNS.includes(word[0].toLowerCase())) continue;
    record(counts, [word[0].toLowerCase()], word.index ?? 0);
    const phrase: string[] = [word[0].toLowerCase()];
    for (let back = 1; back <= 2; back += 1) {
      const previous = words[position - back];
      if (!previous) break;
      const token = previous[0].toLowerCase();
      if (NOT_TITLE_WORDS.has(token) || TITLE_NOUNS.includes(token)) break;
      phrase.unshift(token);
      record(counts, phrase, previous.index ?? 0);
      if (MODIFIERS.includes(token)) break;
    }
  }

  if (!counts.size) return '';
  const [best] = [...counts.entries()].sort((a, b) => score(b[1]) - score(a[1]));
  return titleCase(best[0]);
}

function record(counts: Map<string, { count: number; words: number; earliestIndex: number }>, phrase: string[], index: number) {
  const key = phrase.join(' ');
  const existing = counts.get(key);
  if (existing) {
    existing.count += 1;
    existing.earliestIndex = Math.min(existing.earliestIndex, index);
  } else {
    counts.set(key, { count: 1, words: phrase.length, earliestIndex: index });
  }
}

function score(entry: { count: number; words: number; earliestIndex: number }) {
  return entry.count * 10 + entry.words * 3 - entry.earliestIndex / 1000;
}
