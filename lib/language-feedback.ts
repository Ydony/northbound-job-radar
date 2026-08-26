import type { LanguageStatus } from './analysis';
import type { JobRecord, LanguageFeedbackVerdict } from './types';

const languageStatuses = new Set<LanguageStatus>(['pass', 'review', 'blocked']);
const feedbackVerdicts = new Set<LanguageFeedbackVerdict>(['', 'correct', 'incorrect']);

export interface LanguageFeedbackUpdate {
  verdict: LanguageFeedbackVerdict;
  correctedStatus: LanguageStatus | '';
  reason: string;
}

export function normalizeLanguageFeedback(
  verdictValue: unknown,
  correctedStatusValue: unknown,
  reasonValue: unknown,
): LanguageFeedbackUpdate | null {
  const verdict = typeof verdictValue === 'string' ? verdictValue.trim() as LanguageFeedbackVerdict : '';
  if (!feedbackVerdicts.has(verdict)) return null;
  if (!verdict) return { verdict: '', correctedStatus: '', reason: '' };

  const correctedStatus = typeof correctedStatusValue === 'string'
    ? correctedStatusValue.trim() as LanguageStatus
    : '';
  if (verdict === 'incorrect' && !languageStatuses.has(correctedStatus as LanguageStatus)) return null;

  const reason = typeof reasonValue === 'string'
    ? reasonValue.trim().replace(/\s+/g, ' ').slice(0, 500)
    : '';
  return {
    verdict,
    correctedStatus: verdict === 'incorrect' ? correctedStatus as LanguageStatus : '',
    reason,
  };
}

export function effectiveLanguageStatus(job: Pick<JobRecord, 'languageStatus' | 'languageFeedback' | 'correctedLanguageStatus'>) {
  return job.languageFeedback === 'incorrect' && job.correctedLanguageStatus
    ? job.correctedLanguageStatus
    : job.languageStatus;
}
