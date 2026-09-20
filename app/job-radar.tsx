'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import IndeedStatusPanel from './indeed-status';
import { CV_MATCHING_ENABLED } from '@/lib/features';
import { defaultSearchCriteria, parseKeywordInput, roleForProfile } from '@/lib/criteria';
import { jobsToCsv, workspaceToJson } from '@/lib/export';
import { countryLabel } from '@/lib/job-identity';
import { sourceNameForUrl } from '@/lib/job-sources';
import { effectiveLanguageStatus } from '@/lib/language-feedback';
import { normalizePlace } from '@/lib/places';
import { MIN_CHARS_TO_CONFIRM_ENGLISH } from '@/lib/analysis';
import { ADZUNA_ATTRIBUTION, ADZUNA_LOCAL_LINKS, adzunaSourcesOnScreen,
  ELA_ATTRIBUTION, ELA_ATTRIBUTION_LINK, needsElaAttribution } from '@/lib/attribution';
import { workplaceLabel, type WorkplaceType } from '@/lib/workplace';
import { SOURCE_RUN_STATUS_RANK, activeFilterPills, bestFitScore, closesToday, criteriaToDraft,
  DASHBOARD_VIEW_LABELS, emptyStateCopy, formatDate, formatSourceReconciliation, isJobExpired, jobInView,
  languageStatusLabel, newSinceCutoff, SORT_MODE_LABELS, sortJobs,
  sourceRunStatusLabel, statusLabel, workspaceCountCopy, type CriteriaDraft, type DashboardView, type FilterPill,
  type SortMode } from '@/lib/dashboard';
import type { HealthReport } from '@/app/api/health/route';
import type { LanguageStatus } from '@/lib/analysis';
import type { AppState, ApplicationStatus, CvSlot, JobCountry, JobRecord, SearchCriteria,
  SearchRun } from '@/lib/types';

type CountryFilter = 'all' | Exclude<JobCountry, 'unknown'>;
type ApplicationFilter = 'all' | ApplicationStatus;

interface SlotState {
  file: File | null;
  text: string;
  busy: boolean;
  message: string;
}

interface FeedbackDraft {
  correctedStatus: LanguageStatus;
  reason: string;
}

const emptySlotState: SlotState = { file: null, text: '', busy: false, message: '' };
const slots: CvSlot[] = ['a', 'b'];
const slotLabels: Record<CvSlot, string> = { a: 'CV 1', b: 'CV 2' };

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

export default function JobRadar() {
  const [state, setState] = useState<AppState>({ profiles: [], jobs: [], criteria: defaultSearchCriteria, searchRuns: [], account: null });
  const [loading, setLoading] = useState(true);
  /**
   * A failed workspace load, kept apart from search messages.
   *
   * It used to be written into the same slot as search progress, so a load that failed looked
   * like an empty workspace: no jobs, no keywords, no statistics, and nothing saying why. That is
   * half of what #53 reported as "keywords and statistics are missing". (Adapted from the
   * codex-lead draft for #53.)
   */
  const [loadError, setLoadError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  // New is the default landing view: a returning user's first question is what arrived
  // since the last search, and that inbox is where the day starts.
  const [view, setView] = useState<DashboardView>('new');
  const [sortMode, setSortMode] = useState<SortMode>('fit');
  const [countryFilter, setCountryFilter] = useState<CountryFilter>('all');
  const [applicationFilter, setApplicationFilter] = useState<ApplicationFilter>('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [workTypeFilter, setWorkTypeFilter] = useState<'all' | WorkplaceType>('all');
  const [cityFilter, setCityFilter] = useState('all');

  /**
   * The filters are a sidebar on a wide screen and a disclosure on a narrow one.
   *
   * Below 850px the layout drops to one column, so the filter column stops sitting beside the
   * results and starts sitting on top of them - about twenty buttons between you and the first
   * job, on every visit. Collapsed, the current view stays visible in the summary, so nothing
   * is hidden that you would otherwise be reading.
   *
   * Starts open so a desktop render is correct on first paint, and closes itself on a narrow
   * viewport once the media query can be read.
   */
  const [filtersOpen, setFiltersOpen] = useState(true);
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 851px)');
    const apply = () => setFiltersOpen(wide.matches);
    apply();
    wide.addEventListener('change', apply);
    return () => wide.removeEventListener('change', apply);
  }, []);

  /**
   * Switching country clears the chosen place.
   *
   * A place belongs to one country, so keeping "Zürich" selected while switching to the
   * Netherlands empties the list with nothing on screen to explain why. Clearing it is the
   * behaviour someone would expect without having to work it out.
   */
  function chooseCountry(next: CountryFilter) {
    setCountryFilter(next);
    setCityFilter('all');
  }
  const [cvSlots, setCvSlots] = useState<Record<CvSlot, SlotState>>({ a: { ...emptySlotState }, b: { ...emptySlotState } });
  const [scrapeBusy, setScrapeBusy] = useState<'' | 'authorized' | 'all'>('');
  const [scrapeMessage, setScrapeMessage] = useState('');
  const [scrapeProgress, setScrapeProgress] = useState<{ label: string; percent: number; step: number; steps: number } | null>(null);
  /**
   * Destructive confirmations, in the app's own styling.
   *
   * These were window.confirm, which meant the two reachable destructive actions in the product
   * were also the only surfaces the design did not control — a system dialog naming the origin,
   * with an OK button, on top of a considered page. It also cannot be styled, cannot say what is
   * about to happen in more than one voice, and reads identically whether you are deleting one
   * job or the whole workspace.
   *
   * Held as a single pending action rather than a boolean per call site so there is exactly one
   * dialog in the tree and no way for two to open at once.
   */
  const confirmDialogRef = useRef<HTMLDialogElement>(null);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    detail: string;
    confirmLabel: string;
    run: () => void;
  } | null>(null);

  // <dialog> rather than a div: showModal gives the focus trap, the Escape key, inert background
  // content and the top layer without reimplementing any of it.
  useEffect(() => {
    const dialog = confirmDialogRef.current;
    if (!dialog) return;
    if (confirmAction && !dialog.open) dialog.showModal();
    if (!confirmAction && dialog.open) dialog.close();
  }, [confirmAction]);

  // The finished-run line is a result, not a status, so it stays until it is read and dismissed
  // rather than vanishing with the progress bar that produced it.
  const [runSummaryDismissed, setRunSummaryDismissed] = useState(true);
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

  const loadWorkspace = useCallback(() => {
    setLoading(true);
    setLoadError('');
    return fetch('/api/state')
      .then((response) => responseJson<AppState>(response))
      .then((next) => {
        const criteria = next.criteria ?? defaultSearchCriteria;
        setState({ ...next, criteria, searchRuns: next.searchRuns ?? [] });
        setCriteriaDraft(criteriaToDraft(criteria));
        // Someone with no role keywords has nothing to search for yet, so open the panel that
        // fixes that instead of leaving them to find it.
        if (!criteria.roleKeywords.some((keyword) => keyword.trim())) setSettingsOpen(true);
      })
      .catch((error: Error) => {
        if (/sign in/i.test(error.message)) window.location.href = '/login';
        else setLoadError('Could not load your saved keywords, jobs and statistics. Check the local server is running, then try again.');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);

  // Older pages beyond the first. The server filters by the saved keywords before paging, so
  // the limit is spent on jobs the criteria keep; this walks the rest. Appended rows are
  // deduplicated by id because a re-seen job can move ahead of the cursor between two loads.
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState('');

  async function loadMoreJobs() {
    const cursor = state.nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError('');
    try {
      const next = await responseJson<AppState>(await fetch(`/api/state?cursor=${encodeURIComponent(cursor)}`));
      setState((current) => {
        const known = new Set(current.jobs.map((job) => job.id));
        const appended = next.jobs.filter((job) => !known.has(job.id));
        return {
          ...current,
          jobs: [...current.jobs, ...appended],
          totalJobs: next.totalJobs ?? current.totalJobs,
          matchingJobs: next.matchingJobs ?? current.matchingJobs,
          hiddenDuplicates: (current.hiddenDuplicates ?? 0) + (next.hiddenDuplicates ?? 0),
          nextCursor: next.nextCursor ?? null,
        };
      });
    } catch (error) {
      setLoadMoreError(error instanceof Error ? error.message : 'Could not load more jobs.');
    } finally {
      setLoadingMore(false);
    }
  }

  const accountIsAdmin = state.account?.role === 'admin';
  /**
   * Preview the app as an ordinary account sees it.
   *
   * This is a **display mode, not a privilege drop**. The account is still an administrator and the
   * server still knows it, so nothing here may be the thing that keeps admin-only sources away from
   * other people — that is enforced in the jobs and search routes, and holds whatever this is set
   * to. Treating a client-side toggle as a security boundary would be exactly the wrong shape.
   *
   * What it is for, in the owner's words: "I could easily search for a job as normal user … and see
   * all the stuff as an admin." It is also the quickest way to confirm the real restrictions hold.
   */
  const [viewAsUser, setViewAsUser] = useState(false);
  const isAdmin = accountIsAdmin && !viewAsUser;

  // In the user preview, drop the rows the server would never have sent to an ordinary account.
  // The server is what enforces this; hiding here is only what makes the preview truthful.
  const visibleToRole = useMemo(() => {
    if (!viewAsUser) return state.jobs;
    const hidden = new Set(state.adminOnlySources ?? []);
    return state.jobs.filter((job) => !hidden.has(job.sourceKey));
  }, [state.jobs, state.adminOnlySources, viewAsUser]);

  // Decided on the server, against advertisement text the client is not sent. Criteria only
  // count once saved, which was already true, and a save refetches this state.
  const criteriaFilteredJobs = useMemo(
    () => visibleToRole.filter((job) => job.matchesCriteria),
    [visibleToRole],
  );

  // The "what's new since last run" baseline: the latest finished run's start, or the
  // last seven days before any run. Read at render so the fallback tracks today.
  const newCutoff = useMemo(
    () => newSinceCutoff(state.searchRuns, new Date().toISOString()),
    [state.searchRuns],
  );

  const counts = useMemo(() => ({
    new: visibleToRole.filter((job) => jobInView(job, 'new', newCutoff)).length,
    all: visibleToRole.filter((job) => jobInView(job, 'all', newCutoff)).length,
    triage: visibleToRole.filter((job) => jobInView(job, 'triage', newCutoff)).length,
    pipeline: visibleToRole.filter((job) => jobInView(job, 'pipeline', newCutoff)).length,
    dismissed: visibleToRole.filter((job) => jobInView(job, 'dismissed', newCutoff)).length,
  }), [newCutoff, visibleToRole]);

  const passesView = useMemo(
    () => (job: JobRecord) => jobInView(job, view, newCutoff),
    [newCutoff, view],
  );

  /**
   * Facet counts: each dimension is counted with every *other* filter applied, so a number shows
   * what selecting that option would actually return rather than a total that may be unreachable.
   */
  const facets = useMemo(() => {
    const inView = visibleToRole.filter(passesView);
    const byCountry = (job: JobRecord) => countryFilter === 'all' || job.country === countryFilter;
    const byApplication = (job: JobRecord) => applicationFilter === 'all' || job.applicationStatus === applicationFilter;
    const bySource = (job: JobRecord) => sourceFilter === 'all' || job.sourceKey === sourceFilter;
    const byWorkType = (job: JobRecord) => workTypeFilter === 'all' || job.workplaceType === workTypeFilter;
    const byCity = (job: JobRecord) => cityFilter === 'all' || normalizePlace(job.location).place === cityFilter;
    const except = (skip: 'country' | 'application' | 'source' | 'workType' | 'city') => inView.filter((job) =>
      (skip === 'country' || byCountry(job))
      && (skip === 'application' || byApplication(job))
      && (skip === 'source' || bySource(job))
      && (skip === 'workType' || byWorkType(job))
      && (skip === 'city' || byCity(job)));
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
      city: tally(except('city'), (job) => normalizePlace(job.location).place),
      // Jobs in this view before the facets narrow them: the empty state reads this to
      // tell facet-hiding apart from keyword-hiding.
      inViewCount: inView.length,
      visible: inView.filter((job) => byCountry(job) && byApplication(job) && bySource(job) && byWorkType(job) && byCity(job)),
    };
  }, [applicationFilter, cityFilter, countryFilter, passesView, sourceFilter, visibleToRole, workTypeFilter]);

  const visibleJobs = useMemo(
    () => sortJobs(facets.visible, sortMode),
    [facets.visible, sortMode],
  );
  const visibleAdzunaSources = useMemo(() => adzunaSourcesOnScreen(visibleJobs), [visibleJobs]);

  const sourceOptions = useMemo(() => [...new Map(visibleToRole.map((job) => [job.sourceKey, job.sourceName])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1])), [visibleToRole]);

  /**
   * The one filter surface: every active constraint, saved keywords and temporary facets
   * alike, as a single removable row above the list. Saved keywords come first because
   * they are the ones that silently empty the list from another screen.
   */
  const pills = useMemo(() => activeFilterPills({
    country: countryFilter,
    city: cityFilter,
    source: sourceFilter,
    sourceName: sourceOptions.find(([key]) => key === sourceFilter)?.[1] ?? '',
    workType: workTypeFilter,
    application: applicationFilter,
    requiredKeywords: state.criteria.requiredKeywords,
    excludedKeywords: state.criteria.excludedKeywords,
  }), [applicationFilter, cityFilter, countryFilter, sourceFilter, sourceOptions, state.criteria, workTypeFilter]);

  function removePill(key: FilterPill['key']) {
    if (key === 'country') chooseCountry('all');
    else if (key === 'city') setCityFilter('all');
    else if (key === 'source') setSourceFilter('all');
    else if (key === 'workType') setWorkTypeFilter('all');
    else if (key === 'application') setApplicationFilter('all');
    else if (key === 'required') void clearSavedKeywords('required');
    else void clearSavedKeywords('excluded');
  }

  function clearAllFilters() {
    chooseCountry('all');
    setSourceFilter('all');
    setWorkTypeFilter('all');
    setApplicationFilter('all');
    // Facets alone may not be the culprit: the keywords empty the list from the
    // settings screen, so clearing everything means clearing those too.
    if (state.criteria.requiredKeywords.length || state.criteria.excludedKeywords.length) {
      void clearSavedKeywords('both');
    }
  }

  /**
   * Jobs the person has opened, per account, in this browser only. The New tab's
   * accent edge is "not yet looked at", and opening the advertisement is what
   * clears it — acting on the card (save, applied, dismiss) counts as looking too.
   */
  const accountEmail = state.account?.email ?? '';
  const [openedJobIds, setOpenedJobIds] = useState<string[]>([]);
  useEffect(() => {
    if (!accountEmail) return;
    try {
      const raw = window.localStorage.getItem(`ajh-opened-jobs:${accountEmail}`);
      setOpenedJobIds(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setOpenedJobIds([]);
    }
  }, [accountEmail]);
  useEffect(() => {
    if (!accountEmail) return;
    try {
      window.localStorage.setItem(`ajh-opened-jobs:${accountEmail}`, JSON.stringify(openedJobIds.slice(-2000)));
    } catch {
      // A browser that refuses storage still gets a working list, just without memory.
    }
  }, [accountEmail, openedJobIds]);
  const openedJobs = useMemo(() => new Set(openedJobIds), [openedJobIds]);

  function markJobOpened(id: string) {
    setOpenedJobIds((current) => (current.includes(id) ? current : [...current.slice(-1999), id]));
  }

  /**
   * Dismissed jobs no longer have a primary tab, so dismissing offers its own way
   * back: a short-lived note above the list with an undo, for the click that meant
   * "not now" rather than "never". The quiet Dismissed link below keeps the rest.
   */
  const [undoDismiss, setUndoDismiss] = useState<{ id: string; title: string } | null>(null);
  const undoTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
  }, []);

  function offerUndo(id: string, title: string) {
    setUndoDismiss({ id, title });
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndoDismiss(null), 9000);
  }

  /**
   * Places to narrow by, grouped under their country.
   *
   * A facet rather than a search field, because a location typed before the search only ever hides
   * results you have not seen yet. Here the choices are the places that actually came back, each
   * with how many jobs are in it.
   *
   * Only possible now that EURES locations resolve to names — this listed "NL32B" until the NUTS
   * codes were mapped, on the source that supplies the most jobs.
   */
  const cityOptions = useMemo(() => {
    const byCountry = new Map<JobCountry, Map<string, number>>();
    for (const job of visibleToRole) {
      // Grouped by the tidied name, so one city is one entry: "Zürich" and "Zürich 8000 ZH" were
      // two rows in this list, as were three spellings of Amsterdam.
      const { place } = normalizePlace(job.location);
      if (!place) continue;
      const cities = byCountry.get(job.country) ?? new Map<string, number>();
      cities.set(place, (cities.get(place) ?? 0) + 1);
      byCountry.set(job.country, cities);
    }
    return [...byCountry.entries()]
      .sort((a, b) => countryLabel(a[0]).localeCompare(countryLabel(b[0])))
      .map(([country, cities]) => ({
        country,
        label: countryLabel(country),
        // Busiest first: with a few hundred places, alphabetical buries the ones worth seeing.
        cities: [...cities.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      }));
  }, [visibleToRole]);

  /**
   * What each source is actually worth: how many jobs it brought in, and what became of them.
   *
   * Found is the total matching the current filter — what the search returned, which is measurable
   * for every source. Not what a source holds in total: the ATS boards do not report that, so a
   * column mixing the two would be worse than useless.
   *
   * The question it exists to answer is which jobs are being lost and where. A source with a large
   * `unknown` share is not returning enough of its advertisements to screen, which is a fixable
   * problem with the source rather than with the filter — and the reverse of what a raw count of
   * jobs would tell you.
   */
  const sourceMetrics = useMemo(() => {
    interface SourceRow {
      key: string; name: string; country: JobCountry;
      found: number; confirmed: number; review: number; unknown: number; blocked: number;
      saved: number; applied: number;
    }
    const metrics = new Map<string, SourceRow>();
    for (const job of visibleToRole) {
      const current = metrics.get(job.sourceKey) ?? {
        key: job.sourceKey, name: job.sourceName, country: job.country,
        found: 0, confirmed: 0, review: 0, unknown: 0, blocked: 0, saved: 0, applied: 0,
      };
      current.found += 1;
      const status = effectiveLanguageStatus(job);
      if (status === 'pass') current.confirmed += 1;
      else if (status === 'review') current.review += 1;
      else if (status === 'unknown') current.unknown += 1;
      else current.blocked += 1;
      if (job.isSaved) current.saved += 1;
      if (job.applicationStatus === 'applied') current.applied += 1;
      metrics.set(job.sourceKey, current);
    }
    // Sorted by how many usable jobs a source produced, which is the whole point of the report -
    // a source returning a thousand unscreenable listings ranks below one returning ten good ones.
    return [...metrics.values()].sort((a, b) => b.confirmed - a.confirmed || b.found - a.found);
  }, [visibleToRole]);

  const share = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

  /**
   * The most recent run, with admin-only sources dropped while previewing as a user.
   *
   * The server already withholds these rows from an ordinary account. An administrator is sent
   * everything, though, so without this the coverage panel kept naming Careerjet and IamExpat in a
   * preview that is supposed to show what somebody else sees — which makes the preview useless for
   * the one thing it exists to check.
   */
  const savedRoleKeywords = state.criteria.roleKeywords.map((keyword) => keyword.trim()).filter(Boolean);
  // Read from the saved criteria rather than the draft: a search uses what was saved, so an
  // untouched tick in the form must not change whether the button works.
  const noCountrySearched = !state.criteria.searchNetherlands && !state.criteria.searchSwitzerland;
  // The most recent finished run, for the compact bar. A returning user's first question is
  // "what happened last time", and until now the only answer was inside a collapsed panel.
  const lastRun = state.searchRuns.find((run) => run.completedAt)?.completedAt ?? '';
  const lastRunAdded = (() => {
    const run = state.searchRuns.find((entry) => entry.completedAt);
    if (!run) return '';
    const added = run.sources.reduce((sum, source) => sum + source.importedCount, 0);
    return added ? ` · ${added} added` : ' · nothing new';
  })();
  const latestRun = useMemo(() => {
    const run = state.searchRuns[0];
    if (!run || !viewAsUser) return run;
    const hidden = new Set(state.adminOnlySources ?? []);
    return { ...run, sources: run.sources.filter((source) => !hidden.has(source.sourceKey)) };
  }, [state.searchRuns, state.adminOnlySources, viewAsUser]);

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

  /**
   * Removing a keyword pill edits the *saved* criteria, not just the screen: the pills
   * name what is actually hiding jobs, so taking one off must bring those jobs back.
   * The draft follows the save, so the settings form never disagrees with the list.
   */
  async function clearSavedKeywords(which: 'required' | 'excluded' | 'both') {
    const draft = criteriaToDraft(state.criteria);
    if (which !== 'required') draft.excludedKeywords = '';
    if (which !== 'excluded') draft.requiredKeywords = '';
    setCriteriaDraft(draft);
    setCriteriaBusy(true);
    setCriteriaMessage('Updating keywords…');
    try {
      await persistCriteria(draft);
      const refreshed = await responseJson<AppState>(await fetch('/api/state'));
      setState(refreshed);
      setCriteriaMessage('Keywords cleared — the list now shows everything they hid.');
    } catch (error) {
      setCriteriaMessage(error instanceof Error ? error.message : 'Could not update keywords.');
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

  async function findJobs(mode: 'authorized' | 'all', sourceGroup?: 'indeed') {
    setScrapeBusy(mode);
    setRunSummaryDismissed(true);
    setScrapeMessage(mode === 'all'
      ? 'Searching every source, including the page-fetching ones. Keep the VPN connected…'
      : 'Searching every source available without the VPN…');
    try {
      const response = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, sourceGroup }),
      });
      // Refusals still come back as an ordinary response with a real status code, so they are read
      // the same way as any other error rather than being buried in the stream.
      if (!response.ok || !response.body) {
        throw new Error(((await response.json()) as { error?: string }).error || 'Could not search.');
      }

      // Progress arrives as newline-delimited JSON while the search runs. Only the last line is the
      // result; everything before it says what is happening. A search takes tens of seconds, and a
      // button that sits there looking broken is why people press it twice.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let last: unknown = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // The final fragment may be an incomplete line; keep it for the next chunk.
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { type?: string; label?: string; percent?: number; step?: number; steps?: number };
          if (event.type === 'progress') {
            setScrapeProgress({
              label: event.label ?? '',
              percent: event.percent ?? 0,
              step: event.step ?? 0,
              steps: event.steps ?? 0,
            });
          } else {
            last = event;
          }
        }
      }
      const result = last as { added: JobRecord[]; run: SearchRun; scanned: number; alreadyKnown: number } | null;
      if (!result?.run) throw new Error('The search ended without returning a result.');
      setState((current) => ({
        ...current,
        jobs: [...result.added, ...current.jobs.filter((job) => !result.added.some((added) => added.id === job.id))],
        searchRuns: [result.run, ...current.searchRuns.filter((run) => run.id !== result.run.id)].slice(0, 12),
      }));
      const completedSources = result.run.sources.filter((source) => source.status === 'complete' || source.status === 'partial').length;
      setScrapeMessage(`${completedSources} sources returned a result. ${result.added.length} jobs added, ${result.alreadyKnown} previously known. See the source report below.`);
      setRunSummaryDismissed(false);
    } catch (error) {
      setScrapeMessage(error instanceof Error ? error.message : 'Could not search the configured job sources.');
    } finally {
      setScrapeProgress(null);
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

  /**
   * "Did you apply?" asked once, on return — finding 10.
   *
   * The card's purpose is to send you off-site, and the Applied state only fills in if you
   * remember to tick it afterwards. Clicking an Apply link records the job; the first window
   * focus after that flashes the card once asking whether you applied. Never a dialog, never
   * repeated: the entry is deleted whether or not you answer.
   */
  const openedApply = useRef(new Map<string, string>());
  const jobsRef = useRef(state.jobs);
  jobsRef.current = state.jobs;
  useEffect(() => {
    function askOnReturn() {
      if (!openedApply.current.size) return;
      for (const [id, title] of openedApply.current) {
        const job = jobsRef.current.find((entry) => entry.id === id);
        if (job && job.applicationStatus !== 'applied') {
          flash(id, `Back from ${title} — tick Applied if you applied.`);
        }
        openedApply.current.delete(id);
      }
    }
    window.addEventListener('focus', askOnReturn);
    return () => window.removeEventListener('focus', askOnReturn);
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
    // Acting on a card counts as looking at it: the unseen edge clears either way.
    markJobOpened(id);
    if (patch.visibilityStatus === 'dismissed') {
      offerUndo(id, previous.find((job) => job.id === id)?.title ?? 'Job');
    } else if (patch.visibilityStatus === 'active') {
      setUndoDismiss((current) => (current?.id === id ? null : current));
    }
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
      setUndoDismiss((current) => (current?.id === id && patch.visibilityStatus === 'dismissed' ? null : current));
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

  function deleteJobs(ids: string[] = [], all = false) {
    const count = all ? state.jobs.length : ids.length;
    if (!count) return;
    setConfirmAction({
      title: all ? 'Delete every analyzed job?' : `Delete ${count} selected job${count === 1 ? '' : 's'}?`,
      detail: all
        ? `This permanently removes all ${count} jobs and their language feedback. Your search criteria remain.`
        : 'This permanently removes the selected jobs and the language feedback recorded against them.',
      confirmLabel: 'Delete',
      run: () => { void runDeleteJobs(ids, all); },
    });
  }

  async function runDeleteJobs(ids: string[], all: boolean) {
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
    if (format === 'json') downloadText(`ik-ben-een-appel-${date}.json`, 'application/json', workspaceToJson(state));
    else downloadText(`ik-ben-een-appel-jobs-${date}.csv`, 'text/csv;charset=utf-8', jobsToCsv(state.jobs));
    setDataMessage(`Exported ${state.jobs.length} job${state.jobs.length === 1 ? '' : 's'} as ${format.toUpperCase()}.`);
  }

  function resetWorkspace() {
    setConfirmAction({
      title: 'Reset the entire workspace?',
      detail: `This permanently deletes ${state.jobs.length} job${state.jobs.length === 1 ? '' : 's'}, all language feedback, and every search criterion. It cannot be undone.`,
      confirmLabel: 'Reset everything',
      run: () => { void runResetWorkspace(); },
    });
  }

  async function runResetWorkspace() {
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
      <header className="topbar" id="top">
        <a className="brand" href="#top"><span className="brand-mark">I</span><span><b>Ik ben een appel</b><small>English job filter</small></span></a>
        <nav aria-label="Main navigation">
          {/* aria-current is the state; the highlight is styled from it rather than from a
              second hand-maintained class, which is how this came to be highlighted on every
              scroll position regardless of where you were. */}
          <a aria-current="page" href="#jobs">Jobs</a>{CV_MATCHING_ENABLED && <a href="#profile">My CVs</a>}
          <a href="#criteria" onClick={() => setSettingsOpen(true)}>Keywords</a>
          <a href="#sources" onClick={() => setStatsOpen(true)}>Statistics</a>
          <a href="/settings">Settings</a>
          {isAdmin && <a href="/admin">Admin</a>}
          {accountIsAdmin && <button
            className={`view-toggle ${viewAsUser ? 'as-user' : ''}`}
            type="button"
            onClick={() => setViewAsUser((current) => !current)}
            title={viewAsUser
              ? 'You are seeing what an ordinary account sees. Your admin access is unchanged.'
              : 'Preview the app as an ordinary account sees it.'}
          >{viewAsUser ? 'Viewing as user' : 'View as user'}</button>}
          <button className="nav-signout" type="button" onClick={signOut}>Sign out</button>
        </nav>
        <span className="source-pill"><i /> Switzerland + Netherlands</span>
        {/* The run bar lives in the sticky header on purpose. It used to render down in the
            workflow section, so pressing Search and scrolling to the list made the run invisible
            — which is when people press Search a second time. */}
        {scrapeProgress && <div className="scrape-progress" role="status" aria-live="polite">
          <div className="scrape-bar"><i style={{ width: `${scrapeProgress.percent}%` }} /></div>
          <p>
            <span>{scrapeProgress.label}</span>
            <b>{scrapeProgress.steps
              ? `${scrapeProgress.step} of ${scrapeProgress.steps} sources · ${scrapeProgress.percent}%`
              : `${scrapeProgress.percent}%`}</b>
          </p>
        </div>}
        {!scrapeProgress && !runSummaryDismissed && scrapeMessage && <div className="run-summary" role="status">
          <span>{scrapeMessage}</span>
          <a href="#sources">Source report</a>
          <button type="button" onClick={() => setRunSummaryDismissed(true)} aria-label="Dismiss the run summary">Dismiss</button>
        </div>}
      </header>

      <section className="workflow">
        <div className="workflow-copy">
          <h2>Find new jobs</h2>
          {/* Explaining what a search does is worth a lot on the first run and nothing on the
              two hundredth, where it is only distance between you and your results. It stays
              while the workspace is empty, which is exactly when it is read. */}
          {!state.jobs.length
            ? <p>One search runs every enabled Swiss and Netherlands source, records what each returned, removes duplicates, and applies the English gate.</p>
            : lastRun && <p className="last-run">Last search {formatDate(lastRun).replace(/^Posted /, '')}{lastRunAdded}</p>}
        </div>
        <button className="jobs-button" type="button" disabled={loading || Boolean(loadError) || Boolean(scrapeBusy) || noCountrySearched} onClick={() => findJobs('authorized')} title="Searches the official and public job APIs. No VPN needed.">
          {scrapeBusy === 'authorized' ? 'Searching…' : isAdmin ? 'Search — VPN off' : 'Find new jobs'} <span>⚡</span>
        </button>
        {isAdmin && <button className="jobs-button admin-only" type="button" disabled={loading || Boolean(loadError) || Boolean(scrapeBusy) || noCountrySearched} onClick={() => findJobs('all')} title="Administrator only. Adds the page-fetching sources. Connect the VPN first.">
          {scrapeBusy === 'all' ? 'Searching all sites…' : 'Search all — VPN on'} <span>⟳</span>
        </button>}
        {noCountrySearched && <p className="form-message" role="status">Both countries are switched off in
          {' '}<a href="#criteria" onClick={() => setSettingsOpen(true)}>Search settings</a>, so there is
          nowhere to search. Turn the Netherlands or Switzerland back on.</p>}
        <p className="form-message" aria-live="polite">{scrapeMessage}</p>
        {isAdmin && <IndeedStatusPanel busy={loading || Boolean(loadError) || Boolean(scrapeBusy)} search={() => { void findJobs('authorized', 'indeed'); }} />}
        {isAdmin && <div className="health-panel">
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
        </div>}
      </section>

      {/* Search settings and statistics sit directly under the search, above the job list.

          #51 put results first by moving these two below every job card. With a real workspace of
          nearly two thousand jobs that is several thousand pixels down, and the owner reported both
          as missing (#53). The audit asked for results first *with setup in a panel*; these are
          that panel in its simplest form. A single line each while closed, so the job list still
          starts near the top, and one click to open, with the list never between you and your own
          settings. */}
      {loadError && <div className="workspace-load-error" role="alert">
        <p>{loadError}</p>
        <button type="button" className="reset-button" onClick={() => void loadWorkspace()}>Retry loading</button>
      </div>}

      <div className="setup-panels">
        <details
          className="setup-panel"
          id="criteria"
          open={settingsOpen}
          onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
        >
          <summary>
            <b>Search settings</b>
            <span>{loadError ? 'Unavailable until the workspace loads'
              : loading ? 'Loading…'
              : savedRoleKeywords.length ? `Roles: ${savedRoleKeywords.join(' · ')}` : 'No role keywords yet — add one to search'}</span>
          </summary>
          <section className="criteria-section">
            <div className="criteria-intro">
              <span className="section-label coral">Search criteria</span>
              <h2>Define what fits</h2>
              <p>Role keywords are what get searched. Required and excluded keywords then narrow what comes back — an ad must contain every required word, and is dropped if it contains an excluded one.</p>
            </div>
            <form className="criteria-form" onSubmit={saveCriteria}>
              <fieldset className="country-switches">
                <legend>Countries to search</legend>
                {([['searchNetherlands', 'The Netherlands'], ['searchSwitzerland', 'Switzerland']] as const)
                  .map(([key, label]) => <label className="switch" key={key}>
                    <input
                      type="checkbox"
                      checked={criteriaDraft[key]}
                      onChange={(event) => setCriteriaDraft({ ...criteriaDraft, [key]: event.target.checked })}
                    />
                    <span>{label}</span>
                  </label>)}
                {/* The UX audit's finding 02: two filtering systems that do not know about each
                    other leave someone unable to tell which one emptied the list. So this says
                    plainly which one it is. */}
                <p>This decides which countries a search contacts. It does not hide jobs you have
                  already collected — to narrow what is on screen, use the country filter above the
                  results.</p>
                {!criteriaDraft.searchNetherlands && !criteriaDraft.searchSwitzerland
                  && <p className="switch-warning">With both off there is nowhere to search, so the
                    search button stays disabled until you turn one back on.</p>}
              </fieldset>
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
              <label className="field keywords"><span>Required keywords (all)</span><input value={criteriaDraft.requiredKeywords} onChange={(event) => setCriteriaDraft({ ...criteriaDraft, requiredKeywords: event.target.value })} placeholder="e.g. SAP, data governance" /></label>
              <label className="field keywords"><span>Exclude if ad contains</span><input value={criteriaDraft.excludedKeywords} onChange={(event) => setCriteriaDraft({ ...criteriaDraft, excludedKeywords: event.target.value })} placeholder="e.g. sales, internship" /></label>
              <div className="criteria-actions"><button className="search-button" type="submit" disabled={criteriaBusy}>{criteriaBusy ? 'Saving…' : 'Save criteria'}</button><button className="reset-button" type="button" disabled={criteriaBusy} onClick={resetCriteria}>Reset</button><p aria-live="polite">{criteriaMessage || `${criteriaFilteredJobs.length} of ${state.jobs.length} analyzed jobs match the saved criteria.`}</p></div>
            </form>
          </section>
        </details>
        <details
          className="setup-panel"
          id="sources"
          open={statsOpen}
          onToggle={(event) => setStatsOpen(event.currentTarget.open)}
        >
          <summary>
            <b>Search statistics</b>
            <span>{loadError ? 'Unavailable until the workspace loads'
              : loading ? 'Loading…'
              : latestRun
                ? `Latest search: ${latestRun.sources.reduce((sum, source) => sum + source.foundCount, 0)} found · ${latestRun.sources.reduce((sum, source) => sum + source.newCount, 0)} new`
                : 'No search has run yet'}</span>
          </summary>
          <section className="source-dashboard">
            <div className="source-dashboard-heading">
              <div><span className="section-label coral">Search coverage</span><h2>What every source returned</h2></div>
              <p>{latestRun ? `Latest run ${new Date(latestRun.completedAt || latestRun.startedAt).toLocaleString('en-GB')}` : 'Run a job search to create the first source report.'}</p>
            </div>
            {latestRun && <div className="source-report-grid">
              {[...latestRun.sources]
                .sort((a, b) => SOURCE_RUN_STATUS_RANK[a.status] - SOURCE_RUN_STATUS_RANK[b.status]
                  || a.sourceName.localeCompare(b.sourceName))
                .map((source) => <article className={`source-report ${source.status}`} key={source.sourceKey}>
                <div><span>{countryLabel(source.country)}</span><b>{sourceRunStatusLabel(source.status)}</b></div>
                <h3>{source.sourceName}</h3>
                {/* The headline is the reconciliation, not just two totals: `new` must visibly
                    account for itself as added + duplicates + skipped, so an excerpt of this line
                    can never read as jobs lost (#94). The cells behind the expander stay as the
                    exact diagnostic numbers. */}
                <p className="source-headline">{source.foundCount} found · {formatSourceReconciliation(source)}</p>
                <details className="source-counts">
                  <summary>All counts</summary>
                  <dl><div><dt>Found</dt><dd>{source.foundCount}</dd></div><div><dt>Known</dt><dd>{source.knownCount}</dd></div><div><dt>New</dt><dd>{source.newCount}</dd></div><div><dt>Added</dt><dd>{source.importedCount}</dd></div><div><dt>Duplicates</dt><dd>{source.duplicateCount}</dd></div><div><dt>Skipped</dt><dd>{source.skippedCount}</dd></div></dl>
                </details>
                <p>{source.message}</p>
              </article>)}
            </div>}
            {/* Administrator only: it is a tool for judging the sources and the filter, not something
                a person looking for work needs to read. */}
            {isAdmin && <div className="source-performance">
              <div>
                <span className="section-label">Conversion by source</span>
                <h3>What each website is actually worth</h3>
                <p>Of everything a source returned, how much could be screened and how much survived. A large <b>too short</b> share means the source is not publishing enough of its advertisements to judge — a problem with the source, not the filter.</p>
              </div>
              {sourceMetrics.length ? <div className="performance-table" role="table" aria-label="Conversion by source">
                <div className="performance-row heading" role="row"><span>Website</span><span>Found</span><span>English</span><span>Review</span><span>Too short</span><span>Blocked</span><span>Applied</span></div>
                {sourceMetrics.map((source) => <div className="performance-row" role="row" key={source.key}>
                  <b>{source.name}<small>{countryLabel(source.country)}</small></b>
                  <span>{source.found}</span>
                  <span className="metric-good">{source.confirmed}<small>{share(source.confirmed, source.found)}</small></span>
                  <span>{source.review}<small>{share(source.review, source.found)}</small></span>
                  <span className={source.unknown / Math.max(1, source.found) > 0.5 ? 'metric-warn' : ''}>{source.unknown}<small>{share(source.unknown, source.found)}</small></span>
                  <span>{source.blocked}<small>{share(source.blocked, source.found)}</small></span>
                  <span>{source.applied}</span>
                </div>)}
              </div> : <p className="no-source-data">No jobs yet. Run a search to fill this in.</p>}
            </div>}
          </section>
        </details>
      </div>

      <section className="results" id="jobs">
        <div className="section-heading"><div><span className="section-label coral">Your workspace</span><h2>Screened jobs</h2></div><span className="status-note">{loading ? 'Loading…'
          // Shown rows are deduplicated on screen, so the count names each live effect
          // separately: keyword filtering (matching, from the server) and duplicate
          // folding (folded copies), rather than calling the shown rows "matching" (#92).
          : workspaceCountCopy({
            shown: state.jobs.length,
            matching: state.matchingJobs ?? state.jobs.length,
            total: state.totalJobs ?? state.jobs.length,
            hiddenDuplicates: state.hiddenDuplicates ?? 0,
            hasMorePages: Boolean(state.nextCursor),
          })}</span></div>
        <details className="data-toolbar" open={selectedJobIds.length > 0}>
          <summary>{selectedJobIds.length ? `${selectedJobIds.length} selected` : 'Data controls'}</summary>
          <button type="button" disabled={!selectedJobIds.length || dataBusy} onClick={() => deleteJobs(selectedJobIds)}>Delete selected</button>
          <button type="button" disabled={!state.jobs.length || dataBusy} onClick={() => exportWorkspace('json')}>Export JSON</button>
          <button type="button" disabled={!state.jobs.length || dataBusy} onClick={() => exportWorkspace('csv')}>Export CSV</button>
          <button className="danger" type="button" disabled={!state.jobs.length || dataBusy} onClick={() => deleteJobs([], true)}>Clear all jobs</button>
          <button className="danger" type="button" disabled={dataBusy || (!state.jobs.length && !state.profiles.length)} onClick={resetWorkspace}>Reset workspace</button>
          <p aria-live="polite">{dataMessage}</p>
        </details>
        <div className="result-layout">
          <details
            className="filters"
            id="pipeline"
            open={filtersOpen}
            onToggle={(event) => setFiltersOpen(event.currentTarget.open)}
          >
            {/* Names the view you are in, so collapsing it does not hide where you are. */}
            <summary>Filters<span>{DASHBOARD_VIEW_LABELS[view]}</span></summary>
            {/* Views moved above the list as three primary tabs; this column keeps the facets. */}
            <b className="filter-group">Country</b>
            <button className={countryFilter === 'all' ? 'active' : ''} onClick={() => chooseCountry('all')}><span>All countries</span><i>{facets.country.all}</i></button>
            {/* Places unfold under the country they belong to, rather than sitting in a separate
                dropdown where the two could disagree. Selecting a country opens its list; the
                places shown are the ones jobs actually came back from. */}
            {(['switzerland', 'netherlands'] as const).map((country) => {
              const group = cityOptions.find((entry) => entry.country === country);
              const open = countryFilter === country;
              return <div className="country-group" key={country}>
                <button className={open ? 'active' : ''} onClick={() => chooseCountry(country)}>
                  <span>{countryLabel(country)}</span><i>{facets.country.get(country)}</i>
                </button>
                {open && group && group.cities.length > 1 && <div className="place-list">
                  <button className={cityFilter === 'all' ? 'active' : ''} onClick={() => setCityFilter('all')}>
                    <span>Everywhere</span><i>{facets.city.all}</i>
                  </button>
                  {group.cities.filter(([city]) => facets.city.get(city) > 0 || city === cityFilter)
                    .map(([city]) => <button className={cityFilter === city ? 'active' : ''} key={city} onClick={() => setCityFilter(city)}>
                      <span>{city}</span><i>{facets.city.get(city)}</i>
                    </button>)}
                </div>}
              </div>;
            })}
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
            {/* Counts are jobs, not websites. "All websites (14)" read as though there were fourteen
                sites; it meant fourteen jobs. A site with nothing in the current view is dropped
                rather than listed at zero - offering a filter that can only empty the list is not
                a filter. The selected one always stays, so choosing it never makes it vanish. */}
            {sourceOptions.length > 1 && <label className="source-filter"><span>Website</span><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="all">All websites — {facets.source.all} job{facets.source.all === 1 ? '' : 's'}</option>{sourceOptions.filter(([key]) => facets.source.get(key) > 0 || key === sourceFilter).map(([key, name]) => <option value={key} key={key}>{name} ({facets.source.get(key)})</option>)}</select></label>}
          </details>
          <div className="job-list">
            {/* Three primary tabs. Review and too-short ads wait behind one quieter link;
                dismissed jobs behind an undo note plus their own quiet link. */}
            <div className="view-tabs" role="group" aria-label="Views">
              <button type="button" className={view === 'new' ? 'active' : ''} onClick={() => setView('new')} title="Jobs first seen since the last search."><span>New</span><i>{counts.new}</i></button>
              <button type="button" className={view === 'all' ? 'active' : ''} onClick={() => setView('all')} title="English confirmed against the full advertisement."><span>All matches</span><i>{counts.all}</i></button>
              <button type="button" className={view === 'pipeline' ? 'active' : ''} onClick={() => setView('pipeline')}><span>Pipeline</span><i>{counts.pipeline}</i></button>
            </div>
            <div className="quiet-links">
              <button type="button" className={view === 'triage' ? 'active' : ''} onClick={() => setView('triage')}>
                {counts.triage ? `${counts.triage} need a look` : 'Nothing needs a look'}
              </button>
              <button type="button" className={view === 'dismissed' ? 'active' : ''} onClick={() => setView('dismissed')}>
                {counts.dismissed ? `Dismissed (${counts.dismissed})` : 'Dismissed'}
              </button>
            </div>
            {/* One filter surface: every active constraint as a removable pill, saved
                keywords first. "Clear all" appears once there is more than one. */}
            <div className="list-toolbar">
              {pills.length > 0 && <div className="pills" aria-label="Active filters">
                {pills.map((pill) => <button
                  key={pill.key}
                  type="button"
                  className="pill"
                  onClick={() => removePill(pill.key)}
                  title={pill.key === 'required' || pill.key === 'excluded'
                    ? 'Remove these keywords from your saved criteria'
                    : 'Remove this filter'}
                ><span>{pill.label}</span><i aria-hidden="true">×</i></button>)}
                {pills.length > 1 && <button type="button" className="pill-clear" onClick={clearAllFilters}>Clear all</button>}
              </div>}
              <label className="sort-control"><span>Sort</span><select
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as SortMode)}
              >{(Object.keys(SORT_MODE_LABELS) as SortMode[]).map((mode) => <option value={mode} key={mode}>{SORT_MODE_LABELS[mode]}</option>)}</select></label>
            </div>
            {undoDismiss && <div className="undo-bar" role="status">
              <span>Dismissed “{undoDismiss.title}”.</span>
              <button type="button" onClick={() => updateJobState(undoDismiss.id, { visibilityStatus: 'active' })}>Undo</button>
              <button type="button" className="undo-close" onClick={() => setUndoDismiss(null)} aria-label="Dismiss this notice">×</button>
            </div>}
            {!loading && visibleJobs.length === 0 && (() => {
              // Server-exact keyword count: total minus matching across every page, not the
              // loaded one — the culprit it names is measured, not guessed.
              const totalJobs = state.totalJobs ?? state.jobs.length;
              const matchingJobs = state.matchingJobs ?? state.jobs.length;
              const copy = emptyStateCopy(view, {
                totalJobs,
                removedByKeywords: Math.max(0, totalJobs - matchingJobs),
                inViewCount: facets.inViewCount,
                hasExcludedKeywords: state.criteria.excludedKeywords.length > 0,
                hasRequiredKeywords: state.criteria.requiredKeywords.length > 0,
                hasMorePages: Boolean(state.nextCursor),
              });
              return <div className="empty-state"><span>◎</span><h3>{copy.title}</h3><p>{copy.detail}</p></div>;
            })()}
            {visibleJobs.map((job) => {
              const bothCvsSaved = CV_MATCHING_ENABLED && state.profiles.filter((profile) => profile.hasCvText).length > 1;
              const displayedLanguageStatus = effectiveLanguageStatus(job);
              const requirements = job.requirements;
              const hasCorrection = job.languageFeedback === 'incorrect' && Boolean(job.correctedLanguageStatus);
              const feedbackDraft = feedbackDrafts[job.id] ?? {
                correctedStatus: job.correctedLanguageStatus || (job.languageStatus === 'pass' ? 'review' : 'pass'),
                reason: job.languageFeedbackReason,
              };
              // Finding 08: where every card in view is English-confirmed by definition, the chip
              // only restates the view, so it is hidden there and kept everywhere else. #46
              // replaced the six view tabs with 'new' and 'all', both of which are match views -
              // the old 'matches' name this tested for no longer exists.
              const showLanguageChip = !((view === 'new' || view === 'all') && displayedLanguageStatus === 'pass');
              const { place: jobCity } = normalizePlace(job.location);
              const sourceDisplayName = job.sourceName || sourceNameForUrl(job.sourceUrl);
              const applied = job.applicationStatus === 'applied';
              // #97: derived from the stored end date, no request. The card stays - the person
              // may have applied - but it must not look current when the advertisement is gone.
              const expired = isJobExpired(job);
              const closing = !expired && closesToday(job);
              // The unseen accent edge is #46's; the verdict's own edge is untouched by it.
              return <article className={`job-card ${displayedLanguageStatus}${openedJobs.has(job.id) ? '' : ' is-unseen'}`} key={job.id}>
                <div className="score-column"><label className="job-select"><input type="checkbox" checked={selectedJobIds.includes(job.id)} onChange={() => toggleJobSelection(job.id)} /><span>Select</span></label></div>
                <div className="job-body">
                  {/* Tier 1 — Read: title first and largest, then one grey line of facts,
                      then the source as the second-largest thing, acting as a filter. */}
                  <h3 className="job-title">{job.title}</h3>
                  <button
                    type="button"
                    className="job-source"
                    onClick={() => setSourceFilter(job.sourceKey)}
                    title={`Show only jobs from ${sourceDisplayName}`}
                  >{sourceDisplayName}</button>
                  <p className="job-subline">{job.company || 'Company not added'} · {jobCity || job.location} · {formatDate(job.postedAt).replace(/^Posted /, '')} · {workplaceLabel(job.workplaceType)} · {countryLabel(job.country)}</p>
                  {/* The copies are kept, not deleted, so the boards they came from stay named -
                      one of them may be the one worth applying through. */}
                  {Boolean(job.duplicateCount) && <p className="duplicate-note">
                    Also posted on {job.duplicateSources?.join(', ')} — {job.duplicateCount} duplicate{job.duplicateCount === 1 ? '' : 's'} hidden
                  </p>}
                  {/* Tier 2 — Judge: exactly two chips. The verdict reason stays visible
                      underneath (the language decision is never shown without its reason);
                      everything proving the match sits behind the expander. */}
                  <div className="judge-row">
                    {/* #97: an advertisement can expire after it was collected, and the card
                        kept looking current until the link led to "no longer active". The
                        row is never hidden or deleted for it - the person may have applied -
                        so the expiry is a chip, derived from the stored end date. */}
                    {expired && <span className="expired-chip" title={`This advertisement closed on ${job.expiresAt.slice(0, 10)}. The link may lead to a page saying it is no longer active.`}>Expired</span>}
                    {closing && <span className="expired-chip closing" title="This advertisement closes today. The link may stop working at any time.">Closes today</span>}
                    {showLanguageChip && <span className={`language-badge ${displayedLanguageStatus}`}>{languageStatusLabel(displayedLanguageStatus)}</span>}
                    {/* bestFitScore is the better of the two CV slot scores, so with CV matching
                        shelved it is 0 on every card - 140 chips all reading "Fit 0", implying a
                        score the product does not currently compute. Gated like every other
                        CV-derived element on this card. */}
                    {CV_MATCHING_ENABLED && <span className="fit-chip" title="Fit against your saved search roles">Fit {bestFitScore(job)}</span>}
                  </div>
                  {hasCorrection && <p className="correction-summary"><b>Your correction:</b> {languageStatusLabel(displayedLanguageStatus)} <span>· Detector: {languageStatusLabel(job.languageStatus)}</span></p>}
                  <p className="language-summary">{hasCorrection ? `Detector note: ${job.languageSummary}` : job.languageSummary}</p>
                  <details className="why-matched">
                    <summary>Why this matched</summary>
                    {/* What the employer asks for, labelled by where it came from: a quotation
                        of the employer's own requirements is not the same claim as the opening
                        line of the advertisement. */}
                    {job.excerpt && <p className={`job-excerpt ${job.excerpt.source}`}>
                      <b>{job.excerpt.source === 'requirements' ? 'Asks for'
                        : job.excerpt.source === 'asked' ? 'Asks for' : 'The role'}</b>
                      {job.excerpt.text}
                    </p>}
                    {bothCvsSaved && <p className="fit-breakdown">
                      {state.profiles.filter((profile) => profile.hasCvText).map((profile) => `${roleForProfile(profile, state.criteria) || slotLabels[profile.slot]}: ${profile.slot === 'a' ? job.fitScoreA : job.fitScoreB}`).join(' · ')}
                    </p>}
                    {/* Only where the employer actually stated requirements under a heading. Roughly
                        a quarter of full-length ads do; the rest show nothing rather than an excerpt
                        of marketing copy, which would read as an answer without being one. */}
                    {requirements && <details className="requirements">
                      <summary>{requirements.heading} <i>{requirements.items.length}</i></summary>
                      <ul>{requirements.items.map((item) => <li key={item}>{item}</li>)}</ul>
                    </details>}
                    {/* Half the catalogue is aggregator teasers of a few hundred characters. Showing
                        nothing there is indistinguishable from a job with no stated requirements, so
                        say which it is and point at the page that has them. The threshold is the one
                        the language gate already uses, so "too short" means one thing in this app. */}
                    {!requirements && job.descriptionLength < MIN_CHARS_TO_CONFIRM_ENGLISH
                      && <p className="requirements-elsewhere">
                        Short listing — {sourceDisplayName} published a
                        preview rather than the full advertisement. The requirements are on the original page.
                      </p>}
                    {CV_MATCHING_ENABLED && <div className="tags">{job.matchedKeywords.slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}{!job.matchedKeywords.length && <span>No clear CV overlap yet</span>}</div>}
                  </details>
                  {/* Tier 3 — Act: one filled pill naming the destination, an outline save
                      icon, an applied checkbox, and everything else behind the "…" menu. */}
                  <div className="act-row">
                    <a
                      className="apply-link apply-pill"
                      href={job.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      title={expired ? `This advertisement closed on ${job.expiresAt.slice(0, 10)} — the page may say it is no longer active.` : undefined}
                      onClick={() => { openedApply.current.set(job.id, sourceDisplayName); markJobOpened(job.id); }}
                    >Apply on {sourceDisplayName} ↗</a>
                    <button
                      type="button"
                      className={`save-icon ${job.isSaved ? 'selected' : ''}`}
                      aria-pressed={job.isSaved}
                      aria-label={job.isSaved ? 'Saved — remove from Pipeline' : 'Save to Pipeline'}
                      title={job.isSaved ? 'Saved — remove from Pipeline' : 'Save to Pipeline'}
                      onClick={() => updateJobState(job.id, { isSaved: !job.isSaved })}
                    >{job.isSaved ? '♥' : '♡'}</button>
                    <label className="applied-check" title="Tick once you have applied on the job site">
                      <input
                        type="checkbox"
                        checked={applied}
                        onChange={() => updateJobState(job.id, { applicationStatus: applied ? 'not_applied' : 'applied' })}
                      />
                      <span>Applied</span>
                    </label>
                    <details className="card-menu">
                      <summary aria-label="More actions for this job">…</summary>
                      <div className="card-menu-body">
                        <button type="button" onClick={() => updateJobState(job.id, { visibilityStatus: job.visibilityStatus === 'dismissed' ? 'active' : 'dismissed' })}>{job.visibilityStatus === 'dismissed' ? 'Restore' : 'Dismiss'}</button>
                        <div className="card-menu-feedback">
                          <span>Was the language result right?</span>
                          <button type="button" className={job.languageFeedback === 'correct' ? 'selected' : ''} disabled={feedbackBusy === job.id} onClick={() => saveLanguageFeedback(job, 'correct')}>✓ Accurate</button>
                          <button type="button" className={job.languageFeedback === 'incorrect' ? 'selected' : ''} disabled={feedbackBusy === job.id} onClick={() => openFeedbackCorrection(job)}>Flag wrong</button>
                          {job.languageFeedback && <button type="button" disabled={feedbackBusy === job.id} onClick={() => saveLanguageFeedback(job, '')}>Clear</button>}
                          {feedbackMessages[job.id] && <small aria-live="polite">{feedbackMessages[job.id]}</small>}
                        </div>
                        {feedbackOpen[job.id] && <div className="feedback-form">
                          <label><span>Correct result</span><select value={feedbackDraft.correctedStatus} onChange={(event) => updateFeedbackDraft(job.id, { correctedStatus: event.target.value as LanguageStatus })}><option value="pass">English confirmed</option><option value="unknown">Not enough of the ad</option><option value="review">Needs review</option><option value="blocked">Local language required</option></select></label>
                          <label><span>Reason (optional)</span><input maxLength={500} value={feedbackDraft.reason} onChange={(event) => updateFeedbackDraft(job.id, { reason: event.target.value })} placeholder="e.g. German is only a plus" /></label>
                          <button type="button" disabled={feedbackBusy === job.id} onClick={() => saveLanguageFeedback(job, 'incorrect', feedbackDraft.correctedStatus, feedbackDraft.reason)}>Save correction</button>
                        </div>}
                      </div>
                    </details>
                  </div>
                  {jobFlash[job.id] && <p className="card-flash" role="status">{jobFlash[job.id]}</p>}
                </div>
                {statusLabel(job) && <span className="status-chip">{statusLabel(job)}</span>}
              </article>;
            })}
            {/* Paging beyond the first page. Only rendered while the server says more follow;
                loading every page up front would bring back the unbounded response this replaces. */}
            {state.nextCursor && <div className="load-more">
              <button className="search-button" type="button" disabled={loading || loadingMore} onClick={() => void loadMoreJobs()}>
                {loadingMore ? 'Loading more jobs…' : `Show more jobs (${state.jobs.length} of ${state.matchingJobs ?? state.jobs.length} matching)`}
              </button>
              {loadMoreError && <p className="form-message" role="status">{loadMoreError}</p>}
            </div>}
          </div>
          {/* The condition EURES reuse rests on: ELA acknowledged as the source, where the
              material is shown. Rendered from the job list actually on screen rather than
              unconditionally, so it is a true statement about what you are looking at. */}
          {needsElaAttribution(visibleJobs) && <p className="source-attribution">
            {ELA_ATTRIBUTION} <a href={ELA_ATTRIBUTION_LINK} target="_blank" rel="noreferrer">EURES legal notice ↗</a>
          </p>}
          {visibleAdzunaSources.length > 0 && <p className="source-attribution">
            {ADZUNA_ATTRIBUTION}{' '}
            {visibleAdzunaSources.map((key, index) => <span key={key}>
              {index > 0 && ' · '}
              <a href={ADZUNA_LOCAL_LINKS[key]} target="_blank" rel="noreferrer">
                {key === 'adzuna.ch' ? 'Adzuna Switzerland' : 'Adzuna Netherlands'} ↗
              </a>
            </span>)}
          </p>}
        </div>
      </section>

      <section className="promise-section">
        <aside className="promise-card">
          <span className="label">A role reaches your match list when</span>
          <ol>
            <li><b>01</b><span>Enough of the advertisement was published to judge it</span></li>
            <li><b>02</b><span>The text is predominantly English</span></li>
            <li><b>03</b><span>No local language is named as required</span></li>
          </ol>
          <p>An ad too short to judge goes to <b>Not enough of the ad</b>, not to your matches. Anything that names a language without clearly requiring it goes to <b>Review</b>. You apply on the original job site yourself.</p>
        </aside>
      </section>

      {CV_MATCHING_ENABLED && <section className="profile-section" id="profile">
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
      </section>}

      <dialog
        className="confirm-dialog"
        ref={confirmDialogRef}
        aria-labelledby="confirm-dialog-title"
        onCancel={(event) => { event.preventDefault(); setConfirmAction(null); }}
        onClose={() => setConfirmAction(null)}
      >
        {confirmAction && <>
          <h2 id="confirm-dialog-title">{confirmAction.title}</h2>
          <p>{confirmAction.detail}</p>
          <div className="confirm-actions">
            <button type="button" className="confirm-cancel" onClick={() => setConfirmAction(null)}>Cancel</button>
            <button type="button" className="confirm-go" onClick={() => {
              const action = confirmAction;
              setConfirmAction(null);
              action.run();
            }}>{confirmAction.confirmLabel}</button>
          </div>
        </>}
      </dialog>

      <footer><b>Ik ben een appel</b><span>An English job-search filter for people who do not speak Dutch · you apply yourself, always</span><a href="#sources">Source report ↑</a><a href="/sources">Where the jobs come from →</a><a href="/privacy">Privacy</a></footer>
    </main>
  );
}
