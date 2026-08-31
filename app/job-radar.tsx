'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { defaultSearchCriteria, matchesSearchCriteria, parseKeywordInput, roleForProfile } from '@/lib/criteria';
import { jobsToCsv, workspaceToJson } from '@/lib/export';
import { countryLabel } from '@/lib/job-identity';
import { sourceNameForUrl } from '@/lib/job-sources';
import { effectiveLanguageStatus } from '@/lib/language-feedback';
import { workplaceLabel, type WorkplaceType } from '@/lib/workplace';
import type { HealthReport } from '@/app/api/health/route';
import type { LanguageStatus } from '@/lib/analysis';
import type { AppState, ApplicationStatus, CvSlot, JobCountry, JobRecord, SearchCriteria,
  SearchRun } from '@/lib/types';

type View = 'matches' | 'review' | 'pipeline' | 'dismissed' | 'all';
type CountryFilter = 'all' | Exclude<JobCountry, 'unknown'>;
type ApplicationFilter = 'all' | ApplicationStatus;

interface SlotState {
  file: File | null;
  text: string;
  busy: boolean;
  message: string;
}

interface CriteriaDraft extends Omit<SearchCriteria, 'requiredKeywords' | 'excludedKeywords' | 'updatedAt'> {
  requiredKeywords: string;
  excludedKeywords: string;
}

interface FeedbackDraft {
  correctedStatus: LanguageStatus;
  reason: string;
}

const emptySlotState: SlotState = { file: null, text: '', busy: false, message: '' };
const slots: CvSlot[] = ['a', 'b'];
const slotLabels: Record<CvSlot, string> = { a: 'CV 1', b: 'CV 2' };

function criteriaToDraft(criteria: SearchCriteria): CriteriaDraft {
  return {
    roleOverrideA: criteria.roleOverrideA,
    roleOverrideB: criteria.roleOverrideB,
    roleKeywords: [...criteria.roleKeywords],
    location: criteria.location,
    workplace: criteria.workplace,
    seniority: criteria.seniority,
    contractType: criteria.contractType,
    requiredKeywords: criteria.requiredKeywords.join(', '),
    excludedKeywords: criteria.excludedKeywords.join(', '),
  };
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}

async function extractCvText(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'txt') return file.text();
  if (extension === 'docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  if (extension === 'pdf') {
    const pdfjs = await import('pdfjs-dist');
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ('str' in item ? item.str as string : '')).join(' '));
    }
    return pages.join('\n');
  }
  throw new Error('Use a PDF, DOCX, or TXT file.');
}

function jobsSearchUrl(role: string, location = '') {
  const term = [role.trim(), 'English'].filter(Boolean).join(' ');
  const url = new URL('https://www.jobs.ch/en/vacancies/');
  url.searchParams.set('advanced', '1');
  url.searchParams.set('term', term);
  if (location.trim()) url.searchParams.set('location', location.trim());
  return url.toString();
}

function statusLabel(job: JobRecord) {
  if (job.visibilityStatus === 'dismissed') return 'Dismissed';
  if (job.applicationStatus === 'applied') return 'Applied';
  if (job.isSaved) return 'Saved';
  return 'Not applied';
}

function bestFitScore(job: JobRecord) {
  return Math.max(job.fitScoreA, job.fitScoreB);
}

function languageStatusLabel(status: LanguageStatus) {
  if (status === 'pass') return 'English sufficient';
  if (status === 'review') return 'Review language';
  return 'Local language required';
}

function formatDate(value: string) {
  if (!value) return 'Posting date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return `Posted ${value.slice(0, 10)}`;
  return `Posted ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)}`;
}

export default function JobRadar() {
  const [state, setState] = useState<AppState>({ profiles: [], jobs: [], criteria: defaultSearchCriteria, searchRuns: [], account: null });
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('matches');
  const [countryFilter, setCountryFilter] = useState<CountryFilter>('all');
  const [applicationFilter, setApplicationFilter] = useState<ApplicationFilter>('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [workTypeFilter, setWorkTypeFilter] = useState<'all' | WorkplaceType>('all');
  const [cvSlots, setCvSlots] = useState<Record<CvSlot, SlotState>>({ a: { ...emptySlotState }, b: { ...emptySlotState } });
  const [scrapeBusy, setScrapeBusy] = useState<'' | 'authorized' | 'all'>('');
  const [scrapeMessage, setScrapeMessage] = useState('');
  const [criteriaDraft, setCriteriaDraft] = useState<CriteriaDraft>(criteriaToDraft(defaultSearchCriteria));
  const [criteriaBusy, setCriteriaBusy] = useState(false);
  const [criteriaMessage, setCriteriaMessage] = useState('');
  const [feedbackOpen, setFeedbackOpen] = useState<Record<string, boolean>>({});
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<string, FeedbackDraft>>({});
  const [feedbackBusy, setFeedbackBusy] = useState('');
  const [feedbackMessages, setFeedbackMessages] = useState<Record<string, string>>({});
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [dataBusy, setDataBusy] = useState(false);
  const [dataMessage, setDataMessage] = useState('');
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [jobFlash, setJobFlash] = useState<Record<string, string>>({});
  const flashTimers = useRef<Record<string, number>>({});

  useEffect(() => {
    fetch('/api/state')
      .then((response) => responseJson<AppState>(response))
      .then((next) => {
        const criteria = next.criteria ?? defaultSearchCriteria;
        setState({ ...next, criteria, searchRuns: next.searchRuns ?? [] });
        setCriteriaDraft(criteriaToDraft(criteria));
      })
      .catch((error: Error) => {
        if (/sign in/i.test(error.message)) window.location.href = '/login';
        else setScrapeMessage(error.message);
      })
      .finally(() => setLoading(false));
  }, []);

  const isAdmin = state.account?.role === 'admin';
  const hasAnyCv = state.profiles.some((profile) => profile.hasCvText);
  const primaryProfile = state.profiles.find((profile) => profile.derivedRole);
  const primaryRole = state.criteria.roleKeywords[0]
    || (primaryProfile ? roleForProfile(primaryProfile, state.criteria) : '');

  const criteriaFilteredJobs = useMemo(
    () => state.jobs.filter((job) => matchesSearchCriteria(job, state.criteria)),
    [state.jobs, state.criteria],
  );

  const counts = useMemo(() => ({
    matches: criteriaFilteredJobs.filter((job) => effectiveLanguageStatus(job) === 'pass' && job.visibilityStatus === 'active').length,
    review: criteriaFilteredJobs.filter((job) => effectiveLanguageStatus(job) === 'review' && job.visibilityStatus === 'active').length,
    pipeline: state.jobs.filter((job) => job.visibilityStatus === 'active' && (job.isSaved || job.applicationStatus === 'applied')).length,
    dismissed: state.jobs.filter((job) => job.visibilityStatus === 'dismissed').length,
  }), [criteriaFilteredJobs, state.jobs]);

  const passesView = useMemo(() => (job: JobRecord) => {
    const matchesCriteria = matchesSearchCriteria(job, state.criteria);
    const languageStatus = effectiveLanguageStatus(job);
    if (view === 'dismissed') return job.visibilityStatus === 'dismissed';
    if (job.visibilityStatus !== 'active') return false;
    if (view === 'matches') return matchesCriteria && languageStatus === 'pass';
    if (view === 'review') return matchesCriteria && languageStatus === 'review';
    if (view === 'pipeline') return job.isSaved || job.applicationStatus === 'applied';
    return matchesCriteria;
  }, [state.criteria, view]);

  /**
   * Facet counts: each dimension is counted with every *other* filter applied, so a number shows
   * what selecting that option would actually return rather than a total that may be unreachable.
   */
  const facets = useMemo(() => {
    const inView = state.jobs.filter(passesView);
    const byCountry = (job: JobRecord) => countryFilter === 'all' || job.country === countryFilter;
    const byApplication = (job: JobRecord) => applicationFilter === 'all' || job.applicationStatus === applicationFilter;
    const bySource = (job: JobRecord) => sourceFilter === 'all' || job.sourceKey === sourceFilter;
    const byWorkType = (job: JobRecord) => workTypeFilter === 'all' || job.workplaceType === workTypeFilter;
    const except = (skip: 'country' | 'application' | 'source' | 'workType') => inView.filter((job) =>
      (skip === 'country' || byCountry(job))
      && (skip === 'application' || byApplication(job))
      && (skip === 'source' || bySource(job))
      && (skip === 'workType' || byWorkType(job)));
    const tally = <T extends string>(jobs: JobRecord[], pick: (job: JobRecord) => T) => {
      const counts = new Map<string, number>();
      for (const job of jobs) counts.set(pick(job), (counts.get(pick(job)) ?? 0) + 1);
      return { all: jobs.length, get: (key: string) => counts.get(key) ?? 0 };
    };
    return {
      country: tally(except('country'), (job) => job.country),
      application: tally(except('application'), (job) => job.applicationStatus),
      source: tally(except('source'), (job) => job.sourceKey),
      workType: tally(except('workType'), (job) => job.workplaceType),
      visible: inView.filter((job) => byCountry(job) && byApplication(job) && bySource(job) && byWorkType(job)),
    };
  }, [applicationFilter, countryFilter, passesView, sourceFilter, state.jobs, workTypeFilter]);

  const visibleJobs = useMemo(
    () => [...facets.visible].sort((a, b) => bestFitScore(b) - bestFitScore(a)),
    [facets.visible],
  );

  const sourceOptions = useMemo(() => [...new Map(state.jobs.map((job) => [job.sourceKey, job.sourceName])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1])), [state.jobs]);

  const sourceMetrics = useMemo(() => {
    const metrics = new Map<string, { key: string; name: string; country: JobCountry; analyzed: number; passing: number; saved: number; applied: number; dismissed: number }>();
    for (const job of state.jobs) {
      const current = metrics.get(job.sourceKey) ?? {
        key: job.sourceKey, name: job.sourceName, country: job.country,
        analyzed: 0, passing: 0, saved: 0, applied: 0, dismissed: 0,
      };
      current.analyzed += 1;
      if (effectiveLanguageStatus(job) === 'pass') current.passing += 1;
      if (job.isSaved) current.saved += 1;
      if (job.applicationStatus === 'applied') current.applied += 1;
      if (job.visibilityStatus === 'dismissed') current.dismissed += 1;
      metrics.set(job.sourceKey, current);
    }
    return [...metrics.values()].sort((a, b) => b.applied - a.applied || b.passing - a.passing || b.analyzed - a.analyzed);
  }, [state.jobs]);

  const latestRun = state.searchRuns[0];

  async function persistCriteria(draft: CriteriaDraft) {
    return responseJson<{ criteria: SearchCriteria }>(await fetch('/api/criteria', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...draft,
        requiredKeywords: parseKeywordInput(draft.requiredKeywords),
        excludedKeywords: parseKeywordInput(draft.excludedKeywords),
      }),
    }));
  }

  async function saveCriteria(event: FormEvent) {
    event.preventDefault();
    setCriteriaBusy(true);
    setCriteriaMessage('Saving search criteria…');
    try {
      const result = await persistCriteria(criteriaDraft);
      const refreshed = await responseJson<AppState>(await fetch('/api/state'));
      setState(refreshed);
      setCriteriaDraft(criteriaToDraft(result.criteria));
      setCriteriaMessage('Criteria saved and applied to search and results.');
    } catch (error) {
      setCriteriaMessage(error instanceof Error ? error.message : 'Could not save criteria.');
    } finally {
      setCriteriaBusy(false);
    }
  }

  async function resetCriteria() {
    const draft = criteriaToDraft(defaultSearchCriteria);
    setCriteriaDraft(draft);
    setCriteriaBusy(true);
    setCriteriaMessage('Resetting criteria…');
    try {
      const result = await persistCriteria(draft);
      const refreshed = await responseJson<AppState>(await fetch('/api/state'));
      setState(refreshed);
      setCriteriaDraft(criteriaToDraft(result.criteria));
      setCriteriaMessage('All optional criteria reset.');
    } catch (error) {
      setCriteriaMessage(error instanceof Error ? error.message : 'Could not reset criteria.');
    } finally {
      setCriteriaBusy(false);
    }
  }

  function updateSlot(slot: CvSlot, patch: Partial<SlotState>) {
    setCvSlots((current) => ({ ...current, [slot]: { ...current[slot], ...patch } }));
  }

  async function chooseCv(slot: CvSlot, file: File | null) {
    updateSlot(slot, { file, text: '', message: '' });
    if (!file) return;
    try {
      updateSlot(slot, { message: 'Reading your CV…' });
      const text = (await extractCvText(file)).replace(/\s+/g, ' ').trim();
      if (text.length < 80) throw new Error('This file contains too little readable text. Try a text-based PDF, DOCX, or TXT file.');
      updateSlot(slot, { text, message: `${text.length.toLocaleString()} characters read. Ready to save.` });
    } catch (error) {
      updateSlot(slot, { file: null, message: error instanceof Error ? error.message : 'Could not read this CV.' });
    }
  }

  async function saveCv(slot: CvSlot, event: FormEvent) {
    event.preventDefault();
    const current = cvSlots[slot];
    if (!current.file || !current.text) return updateSlot(slot, { message: 'Choose a readable CV first.' });
    updateSlot(slot, { busy: true, message: 'Saving and detecting a role…' });
    try {
      const form = new FormData();
      form.set('slot', slot);
      form.set('cvText', current.text);
      form.set('file', current.file);
      const result = await responseJson<{ cv: AppState['profiles'][number] }>(await fetch('/api/profile', { method: 'POST', body: form }));
      const refreshed = await responseJson<AppState>(await fetch('/api/state'));
      setState(refreshed);
      updateSlot(slot, { message: result.cv.derivedRole ? `Saved. Detected role: ${result.cv.derivedRole}` : 'Saved, but no role could be detected — try a CV with a clearer job title.' });
    } catch (error) {
      updateSlot(slot, { message: error instanceof Error ? error.message : 'Could not save this CV.' });
    } finally {
      updateSlot(slot, { busy: false });
    }
  }

  async function signOut() {
    await fetch('/api/auth', { method: 'DELETE' }).catch(() => undefined);
    window.location.href = '/login';
  }

  async function checkHealth() {
    setHealthBusy(true);
    try {
      setHealth(await responseJson<HealthReport>(await fetch('/api/health')));
    } catch {
      setHealth(null);
    } finally {
      setHealthBusy(false);
    }
  }

  async function findJobs(mode: 'authorized' | 'all') {
    setScrapeBusy(mode);
    setScrapeMessage(mode === 'all'
      ? 'Searching every source, including the page-fetching ones. Keep the VPN connected…'
      : 'Searching the official and keyed APIs only. No VPN needed…');
    try {
      const result = await responseJson<{ added: JobRecord[]; run: SearchRun; scanned: number; alreadyKnown: number }>(
        await fetch('/api/scrape', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode }),
        }),
      );
      setState((current) => ({
        ...current,
        jobs: [...result.added, ...current.jobs.filter((job) => !result.added.some((added) => added.id === job.id))],
        searchRuns: [result.run, ...current.searchRuns.filter((run) => run.id !== result.run.id)].slice(0, 12),
      }));
      const completedSources = result.run.sources.filter((source) => source.status === 'complete' || source.status === 'partial').length;
      setScrapeMessage(`${completedSources} sources returned a result. ${result.added.length} jobs added, ${result.alreadyKnown} previously known. See the source report below.`);
    } catch (error) {
      setScrapeMessage(error instanceof Error ? error.message : 'Could not search the configured job sources.');
    } finally {
      setScrapeBusy('');
    }
  }

  /**
   * Say what just happened, on the card it happened to, then get out of the way.
   *
   * Save, applied and dismiss all used to change the list silently. On a list this long that reads
   * as a click that did not register, and dismissing removes the card from the current view
   * entirely, so the only feedback was something vanishing.
   */
  function flash(id: string, message: string) {
    setJobFlash((current) => ({ ...current, [id]: message }));
    window.clearTimeout(flashTimers.current[id]);
    flashTimers.current[id] = window.setTimeout(() => {
      setJobFlash((current) => Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== id)));
    }, 3200);
  }

  // Cleared on unmount so a pending timer cannot set state on a component that has gone away.
  useEffect(() => {
    const timers = flashTimers.current;
    return () => { for (const timer of Object.values(timers)) window.clearTimeout(timer); };
  }, []);

  function actionMessage(patch: Partial<Pick<JobRecord, 'isSaved' | 'applicationStatus' | 'visibilityStatus'>>) {
    if (patch.visibilityStatus === 'dismissed') return 'Dismissed — moved to Dismissed.';
    if (patch.visibilityStatus === 'active') return 'Restored to the list.';
    if (patch.applicationStatus === 'applied') return 'Marked applied — moved to Pipeline.';
    if (patch.applicationStatus === 'not_applied') return 'Marked not applied.';
    if (patch.isSaved === true) return 'Saved to Pipeline.';
    if (patch.isSaved === false) return 'Removed from saved.';
    return 'Updated.';
  }

  async function updateJobState(id: string, patch: Partial<Pick<JobRecord, 'isSaved' | 'applicationStatus' | 'visibilityStatus'>>) {
    const previous = state.jobs;
    setState((current) => ({ ...current, jobs: current.jobs.map((job) => job.id === id ? { ...job, ...patch } : job) }));
    flash(id, actionMessage(patch));
    try {
      await responseJson(await fetch(`/api/jobs/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }));
    } catch (error) {
      setState((current) => ({ ...current, jobs: previous }));
      // The optimistic update has been rolled back, so the confirmation must be too - saying
      // "Saved" next to a card that quietly reverted is worse than saying nothing.
      flash(id, error instanceof Error ? `Not saved: ${error.message}` : 'Not saved — the change was undone.');
    }
  }

  function openFeedbackCorrection(job: JobRecord) {
    setFeedbackOpen((current) => ({ ...current, [job.id]: !current[job.id] }));
    setFeedbackDrafts((current) => current[job.id] ? current : {
      ...current,
      [job.id]: {
        correctedStatus: job.correctedLanguageStatus || (job.languageStatus === 'pass' ? 'review' : 'pass'),
        reason: job.languageFeedbackReason,
      },
    });
  }

  function updateFeedbackDraft(id: string, patch: Partial<FeedbackDraft>) {
    setFeedbackDrafts((current) => {
      const existing = current[id] ?? { correctedStatus: 'review' as const, reason: '' };
      return { ...current, [id]: { ...existing, ...patch } };
    });
  }

  async function saveLanguageFeedback(
    job: JobRecord,
    languageFeedback: JobRecord['languageFeedback'],
    correctedLanguageStatus: JobRecord['correctedLanguageStatus'] = '',
    languageFeedbackReason = '',
  ) {
    setFeedbackBusy(job.id);
    setFeedbackMessages((current) => ({ ...current, [job.id]: 'Saving…' }));
    try {
      const result = await responseJson<{ feedback: {
        verdict: JobRecord['languageFeedback'];
        correctedStatus: JobRecord['correctedLanguageStatus'];
        reason: string;
      } }>(await fetch(`/api/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ languageFeedback, correctedLanguageStatus, languageFeedbackReason }),
      }));
      setState((current) => ({
        ...current,
        jobs: current.jobs.map((entry) => entry.id === job.id ? {
          ...entry,
          languageFeedback: result.feedback.verdict,
          correctedLanguageStatus: result.feedback.correctedStatus,
          languageFeedbackReason: result.feedback.reason,
          languageFeedbackUpdatedAt: result.feedback.verdict ? new Date().toISOString() : '',
        } : entry),
      }));
      setFeedbackOpen((current) => ({ ...current, [job.id]: false }));
      setFeedbackMessages((current) => ({
        ...current,
        [job.id]: result.feedback.verdict ? 'Language feedback saved.' : 'Language feedback cleared.',
      }));
    } catch (error) {
      setFeedbackMessages((current) => ({
        ...current,
        [job.id]: error instanceof Error ? error.message : 'Could not save language feedback.',
      }));
    } finally {
      setFeedbackBusy('');
    }
  }

  async function deleteCv(slot: CvSlot) {
    const profile = state.profiles.find((entry) => entry.slot === slot);
    if (!profile || !window.confirm(`Delete ${slotLabels[slot]} (${profile.cvFileName}) and its stored file? Existing jobs will be rescored with the remaining CV.`)) return;
    updateSlot(slot, { busy: true, message: 'Deleting CV and rescoring jobs…' });
    try {
      await responseJson(await fetch(`/api/profile?slot=${slot}`, { method: 'DELETE' }));
      const refreshed = await responseJson<AppState>(await fetch('/api/state'));
      setState(refreshed);
      setCriteriaDraft(criteriaToDraft(refreshed.criteria));
      setCvSlots((current) => ({ ...current, [slot]: { ...emptySlotState, message: 'CV deleted.' } }));
    } catch (error) {
      updateSlot(slot, { message: error instanceof Error ? error.message : 'Could not delete this CV.' });
    } finally {
      updateSlot(slot, { busy: false });
    }
  }

  function toggleJobSelection(id: string) {
    setSelectedJobIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
  }

  async function deleteJobs(ids: string[] = [], all = false) {
    const count = all ? state.jobs.length : ids.length;
    if (!count || !window.confirm(all
      ? `Delete all ${count} analyzed jobs and their language feedback? Your CVs and search criteria will remain.`
      : `Delete ${count} selected job${count === 1 ? '' : 's'} and associated feedback?`)) return;
    setDataBusy(true);
    setDataMessage('Deleting jobs…');
    try {
      const result = await responseJson<{ deletedJobs: number }>(await fetch('/api/jobs', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(all ? { all: true } : { ids }),
      }));
      setState((current) => ({
        ...current,
        jobs: all ? [] : current.jobs.filter((job) => !ids.includes(job.id)),
      }));
      setSelectedJobIds([]);
      setDataMessage(`Deleted ${result.deletedJobs} job${result.deletedJobs === 1 ? '' : 's'}.`);
    } catch (error) {
      setDataMessage(error instanceof Error ? error.message : 'Could not delete jobs.');
    } finally {
      setDataBusy(false);
    }
  }

  function downloadText(fileName: string, type: string, content: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportWorkspace(format: 'json' | 'csv') {
    const date = new Date().toISOString().slice(0, 10);
    if (format === 'json') downloadText(`northbound-${date}.json`, 'application/json', workspaceToJson(state));
    else downloadText(`northbound-jobs-${date}.csv`, 'text/csv;charset=utf-8', jobsToCsv(state.jobs));
    setDataMessage(`Exported ${state.jobs.length} job${state.jobs.length === 1 ? '' : 's'} as ${format.toUpperCase()}.`);
  }

  async function resetWorkspace() {
    if (!window.confirm(`Reset the entire workspace? This permanently deletes ${state.profiles.length} CV file${state.profiles.length === 1 ? '' : 's'}, ${state.jobs.length} jobs, feedback, and all search criteria.`)) return;
    setDataBusy(true);
    setDataMessage('Resetting workspace…');
    try {
      await responseJson(await fetch('/api/workspace', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: 'RESET' }),
      }));
      setState({ profiles: [], jobs: [], criteria: defaultSearchCriteria, searchRuns: [], account: state.account });
      setCriteriaDraft(criteriaToDraft(defaultSearchCriteria));
      setCvSlots({ a: { ...emptySlotState }, b: { ...emptySlotState } });
      setSelectedJobIds([]);
      setFeedbackOpen({});
      setFeedbackDrafts({});
      setFeedbackMessages({});
      setDataMessage('Workspace reset complete.');
    } catch (error) {
      setDataMessage(error instanceof Error ? error.message : 'Could not reset the workspace.');
    } finally {
      setDataBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="#top"><span className="brand-mark">I</span><span><b>Ik ben een appel</b><small>English job filter</small></span></a>
        <nav aria-label="Main navigation">
          <a className="active" href="#jobs">Matches</a><a href="#profile">My CVs</a>
          <a href="/settings">Settings</a>
          {isAdmin && <a href="/admin">Admin</a>}
          <button className="nav-signout" type="button" onClick={signOut}>Sign out</button>
        </nav>
        <span className="source-pill"><i /> Switzerland + Netherlands</span>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <span className="eyebrow">English-only roles · Switzerland + Amsterdam</span>
          <h1>Less searching.<br /><em>More fitting.</em></h1>
          <p>Search Swiss and Netherlands job sites, then let this private workspace reject ads that require German, French, Italian or Dutch and rank the rest against your CVs.</p>
          <div className="hero-actions">
            <a className="primary" href="#profile">Add your CVs <span>↓</span></a>
            <a className="secondary" href={jobsSearchUrl(primaryRole, state.criteria.location)} target="_blank" rel="noreferrer">Open jobs.ch <span>↗</span></a>
          </div>
        </div>
        <aside className="promise-card">
          <span className="label">A role reaches your match list when</span>
          <ol>
            <li><b>01</b><span>The full advertisement is predominantly English</span></li>
            <li><b>02</b><span>No local language is marked as mandatory</span></li>
            <li><b>03</b><span>Your best-fitting CV is scored with visible evidence</span></li>
          </ol>
          <p>Unclear ads go to Review. Applications stay on the original job site, where you sign in yourself.</p>
        </aside>
      </section>

      <section className="profile-section" id="profile">
        <div className="profile-intro"><span className="section-label">Step one</span><h2>Upload up to two CVs</h2><p>Each CV is stored privately. We detect a likely target role and use it to shape your Swiss and Netherlands searches.</p></div>
        <div className="cv-slots">
          {slots.map((slot) => {
            const saved = state.profiles.find((profile) => profile.slot === slot);
            const local = cvSlots[slot];
            return (
              <form className="profile-form" key={slot} onSubmit={(event) => saveCv(slot, event)}>
                <span className="cv-slot-label">{slotLabels[slot]}</span>
                <label className={`upload-box ${local.file ? 'has-file' : ''}`}>
                  <span className="upload-icon">↑</span>
                  <span><b>{local.file?.name || saved?.cvFileName || 'Upload a CV'}</b><small>PDF, DOCX or TXT · max 10 MB</small></span>
                  <input type="file" accept=".pdf,.docx,.txt" onChange={(event) => chooseCv(slot, event.target.files?.[0] ?? null)} />
                </label>
                <div className="cv-actions"><button className="search-button" type="submit" disabled={local.busy}>{local.busy ? 'Saving…' : saved ? 'Update' : 'Save'}</button>{saved && <button className="delete-button" type="button" disabled={local.busy} onClick={() => deleteCv(slot)}>Delete CV</button>}</div>
                <p className="form-message" aria-live="polite">{local.message || (saved ? (saved.derivedRole ? `Detected role: ${saved.derivedRole}` : 'No role detected yet.') : 'Your CV never goes to jobs.ch from this app.')}</p>
              </form>
            );
          })}
        </div>
      </section>

      <section className="criteria-section" id="criteria">
        <div className="criteria-intro">
          <span className="section-label coral">Search criteria</span>
          <h2>Define what fits</h2>
          <p>CV overrides and five extra role keywords shape automatic searches. The remaining fields filter your combined local results.</p>
        </div>
        <form className="criteria-form" onSubmit={saveCriteria}>
          <label className="field"><span>CV 1 role override</span><input value={criteriaDraft.roleOverrideA} onChange={(event) => setCriteriaDraft({ ...criteriaDraft, roleOverrideA: event.target.value })} placeholder={state.profiles.find((profile) => profile.slot === 'a')?.derivedRole || 'Use detected role'} /></label>
          <label className="field"><span>CV 2 role override</span><input value={criteriaDraft.roleOverrideB} onChange={(event) => setCriteriaDraft({ ...criteriaDraft, roleOverrideB: event.target.value })} placeholder={state.profiles.find((profile) => profile.slot === 'b')?.derivedRole || 'Use detected role'} /></label>
          <div className="role-keywords">
            <span>Additional search roles · up to five</span>
            <div>{Array.from({ length: 5 }, (_, index) => <label className="field" key={index}>
              <span>Role {index + 1}</span>
              <input value={criteriaDraft.roleKeywords[index] ?? ''} onChange={(event) => {
                const roleKeywords = [...criteriaDraft.roleKeywords];
                roleKeywords[index] = event.target.value;
                setCriteriaDraft({ ...criteriaDraft, roleKeywords });
              }} placeholder={index === 0 ? 'e.g. Master Data' : index === 1 ? 'e.g. Supply Chain' : 'Optional role keyword'} />
            </label>)}</div>
          </div>
          <label className="field"><span>Location / canton</span><input value={criteriaDraft.location} onChange={(event) => setCriteriaDraft({ ...criteriaDraft, location: event.target.value })} placeholder="e.g. Zürich" /></label>
          <label className="field"><span>Workplace</span><select value={criteriaDraft.workplace} onChange={(event) => setCriteriaDraft({ ...criteriaDraft, workplace: event.target.value as SearchCriteria['workplace'] })}><option value="any">Any</option><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="onsite">On-site</option></select></label>
          <label className="field"><span>Seniority</span><select value={criteriaDraft.seniority} onChange={(event) => setCriteriaDraft({ ...criteriaDraft, seniority: event.target.value as SearchCriteria['seniority'] })}><option value="any">Any</option><option value="internship">Internship</option><option value="entry">Entry / junior</option><option value="mid">Mid-level</option><option value="senior">Senior</option><option value="lead">Lead / principal</option></select></label>
          <label className="field"><span>Contract type</span><select value={criteriaDraft.contractType} onChange={(event) => setCriteriaDraft({ ...criteriaDraft, contractType: event.target.value as SearchCriteria['contractType'] })}><option value="any">Any</option><option value="permanent">Permanent / full-time</option><option value="temporary">Temporary / fixed-term</option><option value="contract">Contract / freelance</option><option value="internship">Internship</option></select></label>
          <label className="field keywords"><span>Required keywords (all)</span><input value={criteriaDraft.requiredKeywords} onChange={(event) => setCriteriaDraft({ ...criteriaDraft, requiredKeywords: event.target.value })} placeholder="e.g. SAP, data governance" /></label>
          <label className="field keywords"><span>Exclude if ad contains</span><input value={criteriaDraft.excludedKeywords} onChange={(event) => setCriteriaDraft({ ...criteriaDraft, excludedKeywords: event.target.value })} placeholder="e.g. sales, internship" /></label>
          <div className="criteria-actions"><button className="search-button" type="submit" disabled={criteriaBusy}>{criteriaBusy ? 'Saving…' : 'Save criteria'}</button><button className="reset-button" type="button" disabled={criteriaBusy} onClick={resetCriteria}>Reset</button><p aria-live="polite">{criteriaMessage || `${criteriaFilteredJobs.length} of ${state.jobs.length} analyzed jobs match the saved criteria.`}</p></div>
        </form>
      </section>

      <section className="workflow">
        <div className="workflow-copy"><span className="section-label coral">Step two</span><h2>Search and screen everywhere</h2><p>One search runs every enabled Swiss and Netherlands adapter, records source failures, removes duplicates, and applies the strict English gate.</p></div>
        <div className="workflow-steps"><span><b>1</b> Search configured sites</span><span><b>2</b> Deduplicate and screen</span><span><b>3</b> Compare source results</span></div>
        <button className="jobs-button" type="button" disabled={!hasAnyCv || Boolean(scrapeBusy)} onClick={() => findJobs('authorized')} title="Official and keyed APIs only (Job-Room, Adzuna, Careerjet). No VPN needed.">
          {scrapeBusy === 'authorized' ? 'Searching…' : isAdmin ? 'Search — VPN off' : 'Find new jobs'} <span>⚡</span>
        </button>
        {isAdmin && <button className="jobs-button admin-only" type="button" disabled={!hasAnyCv || Boolean(scrapeBusy)} onClick={() => findJobs('all')} title="Administrator only. Adds the page-fetching sources. Connect the VPN first.">
          {scrapeBusy === 'all' ? 'Searching all sites…' : 'Search all — VPN on'} <span>⟳</span>
        </button>}
        <a className={`jobs-button ${!hasAnyCv ? 'disabled' : ''}`} href={jobsSearchUrl(primaryRole, state.criteria.location)} target={hasAnyCv ? '_blank' : undefined} rel="noreferrer">Open jobs.ch <span>↗</span></a>
        <p className="form-message" aria-live="polite">{scrapeMessage}</p>
        <div className="health-panel">
          <div className="health-head">
            <b>Source health</b>
            <button type="button" onClick={checkHealth} disabled={healthBusy}>{healthBusy ? 'Checking…' : 'Check now'}</button>
          </div>
          {!health && <p>{healthBusy ? 'Contacting each keyed source…' : 'Run a check to confirm your IP still matches what Careerjet expects.'}</p>}
          {health && <>
            {/* The probe result decides the tone, not the IP comparison. CAREERJET_USER_IP is only
                the value configured here, so a mismatch while Careerjet is answering means the
                local note has gone stale on a dynamic home connection - worth correcting, but not
                a failure, and showing it in red next to "Working" simply contradicted itself. */}
            <p className={health.ipMatches || health.careerjetWorking ? 'health-ok' : 'health-warn'}>
              {health.ipMatches
                ? `Your IP ${health.publicIp} matches the one declared to Careerjet.`
                : health.careerjetWorking
                  ? `Careerjet is answering normally. Your IP is now ${health.publicIp || 'unknown'} while CAREERJET_USER_IP still says ${health.declaredIp || 'none declared'} — update the local value when convenient so this check stays meaningful.`
                  : `Careerjet is not answering, and your IP has changed: it is now ${health.publicIp || 'unknown'} but CAREERJET_USER_IP says ${health.declaredIp || 'none declared'}. Update both that value and the declared IP in your Careerjet account.`}
            </p>
            <ul>
              {health.sources.map((source) => <li key={source.key}>
                <span className={`health-dot ${source.status}`} />
                <b>{source.name}</b>
                <span>{source.status === 'ok' ? 'Working' : source.status === 'failing' ? 'Failing' : 'Not configured'} — {source.detail}</span>
              </li>)}
            </ul>
          </>}
        </div>
      </section>

      <section className="source-dashboard" id="sources">
        <div className="source-dashboard-heading">
          <div><span className="section-label coral">Search coverage</span><h2>What every source returned</h2></div>
          <p>{latestRun ? `Latest run ${new Date(latestRun.completedAt || latestRun.startedAt).toLocaleString('en-GB')}` : 'Run Search all job sites to create the first source report.'}</p>
        </div>
        {latestRun && <div className="source-report-grid">
          {latestRun.sources.map((source) => <article className={`source-report ${source.status}`} key={source.sourceKey}>
            <div><span>{countryLabel(source.country)}</span><b>{source.status}</b></div>
            <h3>{source.sourceName}</h3>
            <dl><div><dt>Found</dt><dd>{source.foundCount}</dd></div><div><dt>Known</dt><dd>{source.knownCount}</dd></div><div><dt>New</dt><dd>{source.newCount}</dd></div><div><dt>Added</dt><dd>{source.importedCount}</dd></div><div><dt>Duplicates</dt><dd>{source.duplicateCount}</dd></div><div><dt>Skipped</dt><dd>{source.skippedCount}</dd></div></dl>
            <p>{source.message}</p>
          </article>)}
        </div>}
        <div className="source-performance">
          <div><span className="section-label">Workspace performance</span><h3>Applications by website</h3><p>Sorted by applications, then English-sufficient opportunities.</p></div>
          {sourceMetrics.length ? <div className="performance-table" role="table" aria-label="Source performance">
            <div className="performance-row heading" role="row"><span>Website</span><span>Analyzed</span><span>English</span><span>Saved</span><span>Applied</span><span>Dismissed</span></div>
            {sourceMetrics.map((source) => <div className="performance-row" role="row" key={source.key}><b>{source.name}<small>{countryLabel(source.country)}</small></b><span>{source.analyzed}</span><span>{source.passing}</span><span>{source.saved}</span><span>{source.applied}</span><span>{source.dismissed}</span></div>)}
          </div> : <p className="no-source-data">No analyzed jobs yet.</p>}
        </div>
      </section>

      <section className="results" id="jobs">
        <div className="section-heading"><div><span className="section-label coral">Your workspace</span><h2>Screened jobs</h2></div><span className="status-note">{loading ? 'Loading…'
          : (state.totalJobs ?? state.jobs.length) > state.jobs.length
            // Say so rather than quietly showing a subset: the oldest jobs fall off the end.
            ? `Showing the ${state.jobs.length} most recent of ${state.totalJobs} analyzed`
            : `${state.jobs.length} analyzed`}</span></div>
        <div className="data-toolbar">
          <span>{selectedJobIds.length ? `${selectedJobIds.length} selected` : 'Data controls'}</span>
          <button type="button" disabled={!selectedJobIds.length || dataBusy} onClick={() => deleteJobs(selectedJobIds)}>Delete selected</button>
          <button type="button" disabled={!state.jobs.length || dataBusy} onClick={() => exportWorkspace('json')}>Export JSON</button>
          <button type="button" disabled={!state.jobs.length || dataBusy} onClick={() => exportWorkspace('csv')}>Export CSV</button>
          <button className="danger" type="button" disabled={!state.jobs.length || dataBusy} onClick={() => deleteJobs([], true)}>Clear all jobs</button>
          <button className="danger" type="button" disabled={dataBusy || (!state.jobs.length && !state.profiles.length)} onClick={resetWorkspace}>Reset workspace</button>
          <p aria-live="polite">{dataMessage}</p>
        </div>
        <div className="result-layout">
          <aside className="filters" id="pipeline">
            <b>Views</b>
            <button className={view === 'matches' ? 'active' : ''} onClick={() => setView('matches')}><span>English matches</span><i>{counts.matches}</i></button>
            <button className={view === 'review' ? 'active' : ''} onClick={() => setView('review')}><span>Needs review</span><i>{counts.review}</i></button>
            <button className={view === 'pipeline' ? 'active' : ''} onClick={() => setView('pipeline')}><span>Pipeline</span><i>{counts.pipeline}</i></button>
            <button className={view === 'dismissed' ? 'active' : ''} onClick={() => setView('dismissed')}><span>Dismissed</span><i>{counts.dismissed}</i></button>
            <button className={view === 'all' ? 'active' : ''} onClick={() => setView('all')}><span>All matching</span><i>{criteriaFilteredJobs.filter((job) => job.visibilityStatus === 'active').length}</i></button>
            <b className="filter-group">Country</b>
            <button className={countryFilter === 'all' ? 'active' : ''} onClick={() => setCountryFilter('all')}><span>All countries</span><i>{facets.country.all}</i></button>
            <button className={countryFilter === 'switzerland' ? 'active' : ''} onClick={() => setCountryFilter('switzerland')}><span>Switzerland</span><i>{facets.country.get('switzerland')}</i></button>
            <button className={countryFilter === 'netherlands' ? 'active' : ''} onClick={() => setCountryFilter('netherlands')}><span>Netherlands</span><i>{facets.country.get('netherlands')}</i></button>
            <b className="filter-group">Work type</b>
            <button className={workTypeFilter === 'all' ? 'active' : ''} onClick={() => setWorkTypeFilter('all')}><span>Any work type</span><i>{facets.workType.all}</i></button>
            <button className={workTypeFilter === 'remote' ? 'active' : ''} onClick={() => setWorkTypeFilter('remote')}><span>Remote</span><i>{facets.workType.get('remote')}</i></button>
            <button className={workTypeFilter === 'hybrid' ? 'active' : ''} onClick={() => setWorkTypeFilter('hybrid')}><span>Hybrid</span><i>{facets.workType.get('hybrid')}</i></button>
            <button className={workTypeFilter === 'onsite' ? 'active' : ''} onClick={() => setWorkTypeFilter('onsite')}><span>On-site</span><i>{facets.workType.get('onsite')}</i></button>
            <button className={workTypeFilter === 'unknown' ? 'active' : ''} onClick={() => setWorkTypeFilter('unknown')}><span>Not stated</span><i>{facets.workType.get('unknown')}</i></button>
            <b className="filter-group">Application</b>
            <button className={applicationFilter === 'all' ? 'active' : ''} onClick={() => setApplicationFilter('all')}><span>All states</span><i>{facets.application.all}</i></button>
            <button className={applicationFilter === 'applied' ? 'active' : ''} onClick={() => setApplicationFilter('applied')}><span>Applied</span><i>{facets.application.get('applied')}</i></button>
            <button className={applicationFilter === 'not_applied' ? 'active' : ''} onClick={() => setApplicationFilter('not_applied')}><span>Not applied</span><i>{facets.application.get('not_applied')}</i></button>
            {sourceOptions.length > 1 && <label className="source-filter"><span>Website</span><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="all">All websites ({facets.source.all})</option>{sourceOptions.map(([key, name]) => <option value={key} key={key}>{name} ({facets.source.get(key)})</option>)}</select></label>}
          </aside>
          <div className="job-list">
            {!loading && visibleJobs.length === 0 && <div className="empty-state"><span>◎</span><h3>{hasAnyCv ? 'No jobs in this view yet' : 'Start with your CV'}</h3><p>{hasAnyCv ? 'Run a search, or widen the filters.' : 'Upload a CV to unlock search, screening and match scores.'}</p></div>}
            {visibleJobs.map((job) => {
              const bothCvsSaved = state.profiles.filter((profile) => profile.hasCvText).length > 1;
              const displayedLanguageStatus = effectiveLanguageStatus(job);
              const hasCorrection = job.languageFeedback === 'incorrect' && Boolean(job.correctedLanguageStatus);
              const feedbackDraft = feedbackDrafts[job.id] ?? {
                correctedStatus: job.correctedLanguageStatus || (job.languageStatus === 'pass' ? 'review' : 'pass'),
                reason: job.languageFeedbackReason,
              };
              return <article className={`job-card ${displayedLanguageStatus}`} key={job.id}>
                <div className="score-column"><label className="job-select"><input type="checkbox" checked={selectedJobIds.includes(job.id)} onChange={() => toggleJobSelection(job.id)} /><span>Select</span></label><div className="score"><strong>{bestFitScore(job)}</strong><span>CV fit</span></div></div>
                <div className="job-body">
                  <div className="job-topline"><span className="job-meta">{job.company || 'Company not added'} · {job.location}</span><span className={`language-badge ${displayedLanguageStatus}`}>{languageStatusLabel(displayedLanguageStatus)}</span></div>
                  <h3>{job.title}</h3>
                  <p className="source-date"><b>{job.sourceName}</b><span>{countryLabel(job.country)}</span><span>{formatDate(job.postedAt)}</span><span className={`work-type ${job.workplaceType}`}>{workplaceLabel(job.workplaceType)}</span></p>
                  {/* The copies are kept, not deleted, so the boards they came from stay named -
                      one of them may be the one worth applying through. */}
                  {Boolean(job.duplicateCount) && <p className="duplicate-note">
                    Also posted on {job.duplicateSources?.join(', ')} — {job.duplicateCount} duplicate{job.duplicateCount === 1 ? '' : 's'} hidden
                  </p>}
                  {hasCorrection && <p className="correction-summary"><b>Your correction:</b> {languageStatusLabel(displayedLanguageStatus)} <span>· Detector: {languageStatusLabel(job.languageStatus)}</span></p>}
                  <p className="language-summary">{hasCorrection ? `Detector note: ${job.languageSummary}` : job.languageSummary}</p>
                  {bothCvsSaved && <p className="fit-breakdown">
                    {state.profiles.filter((profile) => profile.hasCvText).map((profile) => `${roleForProfile(profile, state.criteria) || slotLabels[profile.slot]}: ${profile.slot === 'a' ? job.fitScoreA : job.fitScoreB}`).join(' · ')}
                  </p>}
                  <div className="tags">{job.matchedKeywords.slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}{!job.matchedKeywords.length && <span>No clear CV overlap yet</span>}</div>
                  <div className="language-feedback">
                    <span>Was the language result right?</span>
                    <button type="button" className={job.languageFeedback === 'correct' ? 'selected' : ''} disabled={feedbackBusy === job.id} onClick={() => saveLanguageFeedback(job, 'correct')}>✓ Accurate</button>
                    <button type="button" className={job.languageFeedback === 'incorrect' ? 'selected' : ''} disabled={feedbackBusy === job.id} onClick={() => openFeedbackCorrection(job)}>Flag wrong</button>
                    {job.languageFeedback && <button type="button" disabled={feedbackBusy === job.id} onClick={() => saveLanguageFeedback(job, '')}>Clear</button>}
                    {feedbackMessages[job.id] && <small aria-live="polite">{feedbackMessages[job.id]}</small>}
                  </div>
                  {feedbackOpen[job.id] && <div className="feedback-form">
                    <label><span>Correct result</span><select value={feedbackDraft.correctedStatus} onChange={(event) => updateFeedbackDraft(job.id, { correctedStatus: event.target.value as LanguageStatus })}><option value="pass">English sufficient</option><option value="review">Needs review</option><option value="blocked">Local language required</option></select></label>
                    <label><span>Reason (optional)</span><input maxLength={500} value={feedbackDraft.reason} onChange={(event) => updateFeedbackDraft(job.id, { reason: event.target.value })} placeholder="e.g. German is only a plus" /></label>
                    <button type="button" disabled={feedbackBusy === job.id} onClick={() => saveLanguageFeedback(job, 'incorrect', feedbackDraft.correctedStatus, feedbackDraft.reason)}>Save correction</button>
                  </div>}
                  <div className="card-actions">
                    <button type="button" className={job.isSaved ? 'selected' : ''} onClick={() => updateJobState(job.id, { isSaved: !job.isSaved })}>♡ {job.isSaved ? 'Saved' : 'Save'}</button>
                    <button type="button" className={job.applicationStatus === 'applied' ? 'selected' : ''} onClick={() => updateJobState(job.id, { applicationStatus: 'applied' })}>✓ Applied</button>
                    <button type="button" className={job.applicationStatus === 'not_applied' ? 'selected' : ''} onClick={() => updateJobState(job.id, { applicationStatus: 'not_applied' })}>○ Not applied</button>
                    <button type="button" onClick={() => updateJobState(job.id, { visibilityStatus: job.visibilityStatus === 'dismissed' ? 'active' : 'dismissed' })}>{job.visibilityStatus === 'dismissed' ? 'Restore' : 'Dismiss'}</button>
                  </div>
                  {jobFlash[job.id] && <p className="card-flash" role="status">{jobFlash[job.id]}</p>}
                </div>
                <a className="apply-link" href={job.sourceUrl} target="_blank" rel="noreferrer">Apply on {job.sourceName || sourceNameForUrl(job.sourceUrl)} ↗</a>
                <span className="status-chip">{statusLabel(job)}</span>
              </article>;
            })}
          </div>
        </div>
      </section>

      <footer><b>Ik ben een appel</b><span>An English job-search filter for people who do not speak Dutch · you apply yourself, always</span><a href="#sources">Source report ↑</a><a href="/sources">Where the jobs come from →</a><a href="/privacy">Privacy</a></footer>
    </main>
  );
}
