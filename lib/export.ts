import { effectiveLanguageStatus } from './language-feedback';
import type { AppState, JobRecord } from './types';

function csvCell(value: unknown) {
  const text = Array.isArray(value) ? value.join(' | ') : String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

export function jobsToCsv(jobs: JobRecord[]) {
  const columns = [
    'title', 'company', 'location', 'sourceUrl', 'effectiveLanguageStatus', 'detectorLanguageStatus',
    'languageSummary', 'languageSignals', 'languageFeedback', 'correctedLanguageStatus',
    'languageFeedbackReason', 'fitScoreA', 'fitScoreB', 'bestCvSlot', 'matchedKeywords',
    'missingKeywords', 'pipelineStatus', 'createdAt', 'updatedAt',
  ];
  const rows = jobs.map((job) => [
    job.title, job.company, job.location, job.sourceUrl, effectiveLanguageStatus(job), job.languageStatus,
    job.languageSummary, job.languageSignals, job.languageFeedback, job.correctedLanguageStatus,
    job.languageFeedbackReason, job.fitScoreA, job.fitScoreB, job.bestCvSlot, job.matchedKeywords,
    job.missingKeywords, job.status, job.createdAt, job.updatedAt,
  ]);
  return [columns.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\r\n');
}

export function workspaceToJson(state: AppState, exportedAt = new Date().toISOString()) {
  return JSON.stringify({
    exportedAt,
    profiles: state.profiles,
    criteria: state.criteria,
    jobs: state.jobs.map((job) => ({ ...job, effectiveLanguageStatus: effectiveLanguageStatus(job) })),
  }, null, 2);
}
