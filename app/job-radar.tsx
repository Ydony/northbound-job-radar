'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import IndeedStatusPanel from './indeed-status';
import { CV_MATCHING_ENABLED } from '@/lib/features';
import { defaultSearchCriteria, parseKeywordInput } from '@/lib/criteria';
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
  DASHBOARD_VIEW_LABELS, emptyStateCopy, formatCountOrUnknown, formatDate, isJobExpired, jobInView,
  LANGUAGE_FILTER_LABELS, languageStatusLabel, MATCHED_SNAPSHOT_NOTE, newSinceCutoff, RUN_TOTALS_HELP,
  runNewMatchedTotals, SORT_MODE_LABELS, sortJobs, sourceRunStatusLabel, statusLabel,
  TOTALS_DEDUPE_NOTE, totalForSource, workspaceCountCopy, type CriteriaDraft, type DashboardView, type FilterPill,
  type LanguageFilter, type SortMode } from '@/lib/dashboard';
import { formatRequirementsRailLabel } from '@/lib/requirements';
import { indeedActiveRoles } from '@/lib/indeed/settings';
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
  // UX-7c: the settings band is open by default — the thing that decides what
  // every search collects is not collapsed behind a trigger on arrival.
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [statsOpen, setStatsOpen] = useState(false);
  // All with Definitely English is the default landing view (#119): it restores
  // the old matches intent — Definitely English across saved active results —
  // while New stays a pure recency inbox that the language choice narrows.
  // Pipeline and Dismissed ignore the language choice (ride-along).
  const [view, setView] = useState<DashboardView>('all');
  const [languageFilter, setLanguageFilter] = useState<LanguageFilter>('pass');
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
   * Start collapsed on both server and client, then apply the viewport after mount.
   * Reading matchMedia in the initializer makes hydration disagree on phones.
   * The collapsed default also avoids a tall open drawer before mobile hydration.
   */
  const [filtersOpen, setFiltersOpen] = useState(false);
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
  /**
   * Double-click guard (#116). State updates propagate on re-render, so two
   * rapid clicks can both enter findJobs before `busy` disables the buttons.
   * The ref flips synchronously: the second click returns before dispatching
   * any network request, and the server lease would attach it anyway.
   */
  const scrapeBusyRef = useRef(false);
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
  /**
   * How many role fields the settings form shows on a phone (UX-6f).
   *
   * Five empty boxes push the save button and the keyword fields far down a phone
   * screen. Below 850px two visible fields plus "+ Add another role" is the agreed
   * layout (docs/design/canvas/MobileSettings.html); desktop keeps all five, as
   * the desktop canvas shows. Filled roles are never hidden: the visible count is
   * derived below as the maximum of this, two, and the filled count.
   */
  const [roleFields, setRoleFields] = useState(2);
  /**
   * Whether the phone layout applies. The collapse above is mobile-only; without
   * this a desktop render would also collapse to two fields, regressing the
   * five-across desktop canvas (docs/design/canvas/SearchSettings.html).
   */
  // Server and first client render must contain the same number of role inputs.
  // The effect can safely collapse the optional empty inputs after hydration.
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 850px)');
    const apply = () => setIsNarrow(narrow.matches);
    apply();
    narrow.addEventListener('change', apply);
    return () => narrow.removeEventListener('change', apply);
  }, []);
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
        // Never hide a saved role behind the collapsed phone layout: expand the
        // visible fields to cover every non-empty role, up to the five maximum.
        const filled = criteria.roleKeywords.filter((keyword) => keyword.trim()).length;
        setRoleFields(Math.min(5, Math.max(2, filled)));
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
          collectionTotals: next.collectionTotals ?? current.collectionTotals,
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

  /**
   * Ordinary-audience preview state (#124 fix).
   *
   * Totals and run rows for the preview come from `/api/state?preview=user`,
   * where the server applies the ordinary audience predicates *before*
   * aggregation and dedupe — the same numbers an ordinary account receives.
   * The previous client-side subtraction of admin aggregates gave false zeros
   * whenever dedupe crossed the audience boundary (hidden primary + public
   * orphan copy). This holds only the caller's own rows, so it reveals nothing
   * another account holds.
   */
  const [userPreview, setUserPreview] = useState<AppState | null>(null);
  useEffect(() => {
    if (!accountIsAdmin || !viewAsUser) {
      setUserPreview(null);
      return;
    }
    let cancelled = false;
    fetch('/api/state?preview=user')
      .then((response) => responseJson<AppState>(response))
      .then((next) => { if (!cancelled) setUserPreview(next); })
      .catch(() => { if (!cancelled) setUserPreview(null); });
    return () => { cancelled = true; };
  }, [accountIsAdmin, viewAsUser]);

  // In the user preview, drop the rows the server would never have sent to an ordinary account.
  // The server is what enforces this; hiding here is only what makes the preview truthful.
  const visibleToRole = useMemo(() => {
    if (!viewAsUser) return state.jobs;
    const hidden = new Set(state.adminOnlySources ?? []);
    return state.jobs.filter((job) => !hidden.has(job.sourceKey));
  }, [state.jobs, state.adminOnlySources, viewAsUser]);

  // Decided on the server, against advertisement text the client is not sent.

  // The "what's new since last run" baseline: the latest finished run's start, or the
  // last seven days before any run. Read at render so the fallback tracks today.
  const newCutoff = useMemo(
    () => newSinceCutoff(state.searchRuns, new Date().toISOString()),
    [state.searchRuns],
  );

  // View-tab counts honour the language choice for the two browsable lifecycles,
  // so the New tab shows new arrivals under the current verdict filter.
  // Pipeline and Dismissed ignore it (ride-along), so their counts are stable.
  // These are loaded-page counts, never whole-workspace totals.
  const counts = useMemo(() => ({
    new: visibleToRole.filter((job) => jobInView(job, 'new', newCutoff, languageFilter)).length,
    all: visibleToRole.filter((job) => jobInView(job, 'all', newCutoff, languageFilter)).length,
    pipeline: visibleToRole.filter((job) => jobInView(job, 'pipeline', newCutoff, languageFilter)).length,
    dismissed: visibleToRole.filter((job) => jobInView(job, 'dismissed', newCutoff, languageFilter)).length,
  }), [languageFilter, newCutoff, visibleToRole]);

  // Language-option counts within the current lifecycle view, before the facet
  // filters narrow them — the same scope the view tabs use, so the two agree.
  const languageCounts = useMemo(() => ({
    pass: visibleToRole.filter((job) => jobInView(job, view, newCutoff, 'pass')).length,
    review: visibleToRole.filter((job) => jobInView(job, view, newCutoff, 'review')).length,
    unknown: visibleToRole.filter((job) => jobInView(job, view, newCutoff, 'unknown')).length,
    blocked: visibleToRole.filter((job) => jobInView(job, view, newCutoff, 'blocked')).length,
    all: visibleToRole.filter((job) => jobInView(job, view, newCutoff, 'all')).length,
  }), [newCutoff, view, visibleToRole]);

  // Pipeline and Dismissed are records of what the person did: the language
  // choice does not narrow them, and the selector says so where it renders.
  const languageApplies = view === 'new' || view === 'all';

  const passesView = useMemo(
    () => (job: JobRecord) => jobInView(job, view, newCutoff, languageFilter),
    [languageFilter, newCutoff, view],
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
   * The one filter surface: every active constraint — saved keywords, the
   * language choice and temporary facets alike — as a single removable row
   * above the list. Saved keywords come first because they are the ones that
   * silently empty the list from another screen. The language pill is hidden
   * in Pipeline/Dismissed, where the choice does not narrow the list.
   */
  const pills = useMemo(() => activeFilterPills({
    country: countryFilter,
    city: cityFilter,
    source: sourceFilter,
    sourceName: sourceOptions.find(([key]) => key === sourceFilter)?.[1] ?? '',
    workType: workTypeFilter,
    application: applicationFilter,
    language: languageApplies ? languageFilter : 'all',
    requiredKeywords: state.criteria.requiredKeywords,
    excludedKeywords: state.criteria.excludedKeywords,
  }), [applicationFilter, cityFilter, countryFilter, languageApplies, languageFilter, sourceFilter, sourceOptions, state.criteria, workTypeFilter]);

  function removePill(key: FilterPill['key']) {
    if (key === 'country') chooseCountry('all');
    else if (key === 'city') setCityFilter('all');
    else if (key === 'source') setSourceFilter('all');
    else if (key === 'workType') setWorkTypeFilter('all');
    else if (key === 'application') setApplicationFilter('all');
    else if (key === 'language') setLanguageFilter('all');
    else if (key === 'required') void clearSavedKeywords('required');
    else void clearSavedKeywords('excluded');
  }

  function clearAllFilters() {
    chooseCountry('all');
    setSourceFilter('all');
    setWorkTypeFilter('all');
    setApplicationFilter('all');
    setCityFilter('all');
    setLanguageFilter('all');
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
  // Read from the saved criteria rather than the draft: a search uses what was saved, so an
  // untouched tick in the form must not change whether the button works.
  const noCountrySearched = !state.criteria.searchNetherlands && !state.criteria.searchSwitzerland;
  /**
   * Empty roles refuse to run (UX-7c). Read from the draft, not the saved
   * criteria: Find new jobs saves first, so what is on screen is what would
   * run — an empty draft means nothing to ask any source for, even if an
   * older saved list exists. The server enforces the same rule, so a crafted
   * request cannot bypass the disabled button.
   */
  const noRolesToSearch = !criteriaDraft.roleKeywords.some((keyword) => (keyword ?? '').trim());
  // The most recent finished run, for the compact bar. A returning user's first question is
  // "what happened last time", and until now the only answer was inside a collapsed panel.
  const lastRun = state.searchRuns.find((run) => run.completedAt)?.completedAt ?? '';
  const lastRunSummary = (() => {
    const run = state.searchRuns.find((entry) => entry.completedAt);
    if (!run) return '';
    const totals = runNewMatchedTotals(run.sources);
    if (!totals.newJobs) return ' · nothing new';
    const matched = totals.matchedUnknown ? 'matched unknown' : `${totals.matchedJobs} matched`;
    return ` · ${totals.newJobs} new · ${matched}`;
  })();
  const latestRun = useMemo(() => {
    // #124 fix: the user preview reads ordinary-audience runs from the server
    // (`/api/state?preview=user`), never by subtracting admin rows client-side.
    // Subtracting breaks the moment dedupe crosses the audience boundary: a
    // hidden jobs.ch primary with a public EURES copy previews as 0 while an
    // ordinary account really sees 1 (the orphan copy is promoted server-side
    // before aggregation). While the preview loads, there is no latest run —
    // an honest gap, not a false zero.
    if (viewAsUser) return userPreview?.searchRuns[0];
    return state.searchRuns[0];
  }, [state.searchRuns, userPreview, viewAsUser]);
  // #124 totals: New and Matched come from the latest run snapshot (unique
  // additions, never provider-returned rows); Total collected comes from the
  // server-retained collection, never from loaded pages or summed found counts.
  const latestRunTotals = useMemo(
    () => runNewMatchedTotals(latestRun?.sources ?? []),
    [latestRun],
  );
  // Collection totals: the server's audience-scoped numbers, never a
  // client-side subtraction. In the user preview the totals come from the
  // preview response (ordinary predicates applied before aggregation); while
  // it loads the total is unknown (—), never a false zero.
  const collectionView = useMemo(() => {
    if (viewAsUser) return userPreview?.collectionTotals ?? null;
    return state.collectionTotals ?? null;
  }, [state.collectionTotals, userPreview, viewAsUser]);

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
    setRoleFields(2);
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
    if (scrapeBusyRef.current) return;
    scrapeBusyRef.current = true;
    setScrapeBusy(mode);
    // UX-7c: Find new jobs saves first. The draft on screen is persisted before
    // anything runs, so a role edited but not saved is what the search uses —
    // the stored role can no longer silently win. A failed save aborts the run
    // instead of searching with stale criteria.
    setScrapeMessage('Saving criteria…');
    try {
      const saved = await persistCriteria(criteriaDraft);
      setCriteriaDraft(criteriaToDraft(saved.criteria));
      setState((current) => ({ ...current, criteria: saved.criteria }));
    } catch (error) {
      setScrapeMessage(error instanceof Error ? error.message : 'Could not save criteria — the search did not run.');
      scrapeBusyRef.current = false;
      setScrapeBusy('');
      return;
    }
    setRunSummaryDismissed(true);
    setScrapeMessage(sourceGroup === 'indeed' ? 'Searching Indeed in the selected countries…' : mode === 'all'
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
        // #124 fix: jobs and the run row update immediately, but Total
        // collected is never derived here. Duplicate folding, orphan promotion
        // and per-source attribution are server-side; the authoritative totals
        // arrive via the reconcile fetch below. Deriving them from
        // importedCount/added.length guesses wrong on folded and unloaded rows.
        ...current,
        jobs: [...result.added, ...current.jobs.filter((job) => !result.added.some((added) => added.id === job.id))],
        searchRuns: [result.run, ...current.searchRuns.filter((run) => run.id !== result.run.id)].slice(0, 12),
      }));
      // Reconcile authoritative retained totals (overall and per-source) right
      // away; do not wait for the next page load. A failure keeps the previous
      // totals rather than a guessed number.
      try {
        const reconciled = await responseJson<AppState>(await fetch('/api/state'));
        setState((current) => ({
          ...current,
          totalJobs: reconciled.totalJobs ?? current.totalJobs,
          matchingJobs: reconciled.matchingJobs ?? current.matchingJobs,
          collectionTotals: reconciled.collectionTotals ?? current.collectionTotals,
        }));
      } catch {
        // Totals stay as they were; the next full state load reconciles them.
      }
      const completedSources = result.run.sources.filter((source) => source.status === 'complete' || source.status === 'partial').length;
      const indeedUnavailable = sourceGroup === 'indeed' && completedSources === 0
        ? result.run.sources.filter(source => source.status !== 'skipped').map(source => source.message).join(' ')
        : '';
      setScrapeMessage(indeedUnavailable || `${completedSources} sources returned a result. ${result.added.length} jobs added, ${result.alreadyKnown} previously known. See the source report below.`);
      setRunSummaryDismissed(false);
    } catch (error) {
      setScrapeMessage(error instanceof Error ? error.message : 'Could not search the configured job sources.');
    } finally {
      setScrapeProgress(null);
      setScrapeBusy('');
      scrapeBusyRef.current = false;
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
        // #124 fix: the visible rows leave immediately, but Total collected is
        // never derived by subtracting them. Deleting a visible primary whose
        // folded copy is retained keeps the server unique total at 1 while
        // naive subtraction shows 0; attribution and unloaded pages break it
        // further. The reconcile fetch below reads the authoritative overall
        // and per-source totals instead.
        ...current,
        jobs: all ? [] : current.jobs.filter((job) => !ids.includes(job.id)),
      }));
      // Deliberate deletion removes rows from the retained collection — Total
      // collected must fall, not preserve deleted records. Reconcile the
      // authoritative server totals right away rather than on the next load.
      try {
        const reconciled = await responseJson<AppState>(await fetch('/api/state'));
        setState((current) => ({
          ...current,
          totalJobs: reconciled.totalJobs ?? (all ? 0 : current.totalJobs),
          matchingJobs: reconciled.matchingJobs ?? current.matchingJobs,
          collectionTotals: reconciled.collectionTotals
            ?? (all ? { total: 0, bySource: [] } : current.collectionTotals),
        }));
        // A preview open during the delete shows the ordinary-audience totals;
        // refresh it too so it never lags the authoritative numbers.
        if (viewAsUser) {
          try {
            const preview = await responseJson<AppState>(await fetch('/api/state?preview=user'));
            setUserPreview(preview);
          } catch {
            // The main totals above are authoritative; the preview retries on toggle.
          }
        }
      } catch {
        // The rows are gone on screen; totals reconcile on the next state load.
        if (all) {
          setState((current) => ({
            ...current, totalJobs: 0, collectionTotals: { total: 0, bySource: [] },
          }));
        }
      }
      setSelectedJobIds([]);
      setDataMessage(`Deleted ${result.deletedJobs} job${result.deletedJobs === 1 ? '' : 's'}. Total collected now excludes them.`);
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
      setState({
        profiles: [], jobs: [], criteria: defaultSearchCriteria, searchRuns: [],
        totalJobs: 0, matchingJobs: 0, collectionTotals: { total: 0, bySource: [] },
        account: state.account,
      });
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
          <a href="#sources" onClick={() => setStatsOpen(true)}>Source report</a>
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
            : lastRun && <p className="last-run">Last search {formatDate(lastRun).replace(/^Posted /, '')}{lastRunSummary}</p>}
        </div>
        <button className="jobs-button" type="button" disabled={loading || Boolean(loadError) || Boolean(scrapeBusy) || noCountrySearched || noRolesToSearch} onClick={() => findJobs('authorized')} title="Searches the official and public job APIs. No VPN needed.">
          {scrapeBusy === 'authorized' ? 'Searching…' : isAdmin ? 'Search — VPN off' : 'Find new jobs'} <span>⚡</span>
        </button>
        {isAdmin && <button className="jobs-button admin-only" type="button" disabled={loading || Boolean(loadError) || Boolean(scrapeBusy) || noCountrySearched || noRolesToSearch} onClick={() => findJobs('all')} title="Administrator only. Adds the page-fetching sources. Connect the VPN first.">
          {scrapeBusy === 'all' ? 'Searching all sites…' : 'Search all — VPN on'} <span>⟳</span>
        </button>}
        {noCountrySearched && <p className="form-message" role="status">Both countries are switched off in
          {' '}<a href="#criteria" onClick={() => setSettingsOpen(true)}>Search settings</a>, so there is
          nowhere to search. Turn the Netherlands or Switzerland back on.</p>}
        <p className="form-message" aria-live="polite">{scrapeMessage}</p>
        {isAdmin && <IndeedStatusPanel busy={loading || Boolean(loadError) || Boolean(scrapeBusy)} searchDisabled={noRolesToSearch} search={() => { void findJobs('authorized', 'indeed'); }}
          roles={indeedActiveRoles(state.criteria.roleKeywords)}
          netherlands={state.criteria.searchNetherlands} switzerland={state.criteria.searchSwitzerland}
          settings={state.indeedSettings ?? null}
          runSources={(latestRun?.sources ?? []).filter((source) => source.sourceKey.startsWith('indeed'))}
          runStartedAt={latestRun?.startedAt ?? null} />}
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
          that panel in its simplest form. UX-6d: the two triggers are tab buttons in one row, so
          both closed is a single line and the job list still starts near the top. One click opens
          a panel attached below its trigger, with the list never between you and your own
          settings. */}
      {loadError && <div className="workspace-load-error" role="alert">
        <p>{loadError}</p>
        <button type="button" className="reset-button" onClick={() => void loadWorkspace()}>Retry loading</button>
      </div>}

      <div className="setup-panels">
        <div className="setup-tabs">
          <button
            type="button"
            className={`setup-tab${statsOpen ? ' is-open' : ''}`}
            aria-expanded={statsOpen}
            aria-controls="sources"
            onClick={() => setStatsOpen((open) => !open)}
          >
            <span className="setup-tab-arrow" aria-hidden="true">{statsOpen ? '▲' : '▼'}</span>
            <b>Search statistics</b>
            <span className="setup-tab-meta">{loadError ? 'Unavailable until the workspace loads'
              : loading ? 'Loading…'
              : latestRun
                ? `${latestRunTotals.newJobs} new · ${
                  latestRunTotals.matchedUnknown ? 'matched unknown' : `${latestRunTotals.matchedJobs} matched`
                } · ${collectionView ? `${collectionView.total} collected` : 'collected unknown'}`
                : collectionView && collectionView.total > 0
                  ? `${collectionView.total} collected · No search has run yet`
                  : 'No search has run yet'}</span>
          </button>
        </div>
        {/* UX-7c: settings is a band on the page, open by default, not a panel
            behind a tab. Everything that decides what a search collects sits
            here: five roles, countries, keywords, and the bar that runs. */}
        {!settingsOpen && <div className="settings-collapsed">
          <button type="button" onClick={() => setSettingsOpen(true)}>
            <span aria-hidden="true">▼</span> Show Search settings
          </button>
        </div>}
        <section className="settings-band" id="criteria" hidden={!settingsOpen} aria-label="Search settings">
          <div className="settings-head">
            <h2>Search settings</h2>
            <p>{latestRun
              ? `Last search ${new Date(latestRun.completedAt || latestRun.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ${latestRunTotals.newJobs} added`
              : 'No search run yet'}</p>
            <button type="button" onClick={() => setSettingsOpen((open) => !open)}>
              <span aria-hidden="true">{settingsOpen ? '▲' : '▼'}</span> {settingsOpen ? 'Hide' : 'Show'}
            </button>
          </div>
          <form onSubmit={saveCriteria}>
            <div className="criteria-grid">
              {(() => {
                // Desktop keeps all five (SearchSettings.html); phones collapse to two
                // plus the add button (MobileSettings.html), never hiding a filled role.
                const filled = criteriaDraft.roleKeywords.filter((keyword) => (keyword ?? '').trim()).length;
                const visible = isNarrow ? Math.min(5, Math.max(2, filled, roleFields)) : 5;
                return <>
                  {Array.from({ length: visible }, (_, index) => <div className="role-cell" key={index}>
                    <label htmlFor={`role-keyword-${index}`} className={noRolesToSearch && index === 0 ? 'bad' : undefined}>Role {index + 1}</label>
                    <input
                      id={`role-keyword-${index}`}
                      value={criteriaDraft.roleKeywords[index] ?? ''}
                      onChange={(event) => {
                        const roleKeywords = [...criteriaDraft.roleKeywords];
                        roleKeywords[index] = event.target.value;
                        setCriteriaDraft({ ...criteriaDraft, roleKeywords });
                      }}
                      placeholder={index === 0 ? 'e.g. Master Data' : index === 1 ? 'e.g. Supply Chain' : index === 2 ? 'Optional' : 'Optional role keyword'}
                      aria-invalid={noRolesToSearch && index === 0}
                      aria-describedby={noRolesToSearch && index === 0 ? 'role-warning' : undefined}
                    />
                  </div>)}
                </>;
              })()}
              {isNarrow && (() => {
                const filled = criteriaDraft.roleKeywords.filter((keyword) => (keyword ?? '').trim()).length;
                const visible = Math.min(5, Math.max(2, filled, roleFields));
                return visible < 5 && <button
                  type="button"
                  className="add-role"
                  onClick={() => setRoleFields((count) => Math.min(5, count + 1))}
                >+ Add another role</button>;
              })()}
              <fieldset className="country-switches">
                <legend>Countries to search</legend>
                <div className="country-options">
                {([['searchNetherlands', 'The Netherlands'], ['searchSwitzerland', 'Switzerland']] as const)
                  .map(([key, label]) => <label className="switch" key={key}>
                    <input
                      type="checkbox"
                      checked={criteriaDraft[key]}
                      onChange={(event) => setCriteriaDraft({ ...criteriaDraft, [key]: event.target.checked })}
                    />
                    <span>{label}</span>
                  </label>)}
                </div>
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
              <div className="keyword-cell keywords-required">
                <label htmlFor="required-keywords">Required keywords</label>
                <input id="required-keywords" value={criteriaDraft.requiredKeywords} onChange={(event) => setCriteriaDraft({ ...criteriaDraft, requiredKeywords: event.target.value })} placeholder="e.g. SAP, data governance" />
                <p>An ad must contain all of these.</p>
              </div>
              <div className="keyword-cell keywords-excluded">
                <label htmlFor="excluded-keywords">Exclude if the ad contains</label>
                <input id="excluded-keywords" value={criteriaDraft.excludedKeywords} onChange={(event) => setCriteriaDraft({ ...criteriaDraft, excludedKeywords: event.target.value })} placeholder="e.g. sales, internship" />
                <p>Any one drops it.</p>
              </div>
            </div>
            {noRolesToSearch && <div className="role-warning" id="role-warning" role="alert">
              <span aria-hidden="true">⚠</span>
              <div>
                <strong>Enter at least one role</strong>
                <p>A role is what the search looks for. With all five empty there is nothing to ask any source for, so the search will not run. Countries and keywords narrow a search; they cannot start one.</p>
              </div>
            </div>}
            <div className="settings-bar">
              <button className="run-button" type="button" disabled={loading || Boolean(loadError) || Boolean(scrapeBusy) || noRolesToSearch} onClick={() => findJobs('authorized')}>Find new jobs</button>
              <button className="save-button" type="submit" disabled={criteriaBusy}>{criteriaBusy ? 'Saving…' : 'Save criteria'}</button>
              <button className="reset-button" type="button" disabled={criteriaBusy} onClick={resetCriteria}>Reset</button>
              <p className="note">{noRolesToSearch
                ? 'Save criteria still works — an empty role list is a valid thing to save while you decide.'
                : `Find new jobs saves these criteria first, so a search always uses what is on screen. Last saved ${state.criteria.updatedAt ? new Date(state.criteria.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'never'}.`}</p>
            </div>
            <p aria-live="polite">{criteriaMessage}</p>
          </form>
        </section>
        <section className="source-dashboard" id="sources" hidden={!statsOpen} aria-label="Search statistics">
            <div className="source-dashboard-heading">
              <div><span className="section-label coral">Search coverage</span><h2>New, matched and collected</h2></div>
              <p>{latestRun ? `Latest run ${new Date(latestRun.completedAt || latestRun.startedAt).toLocaleString('en-GB')}` : 'Run a job search to create the first source report.'}</p>
            </div>
            <p className="source-dashboard-explainer">{RUN_TOTALS_HELP} {MATCHED_SNAPSHOT_NOTE}</p>
            {latestRun && <div className="source-overall" role="status" aria-label="Overall search totals">
              <div><b>{latestRunTotals.newJobs}</b><span>New this search</span><small>first-time jobs this run added</small></div>
              <div><b>{latestRunTotals.matchedUnknown ? '—' : latestRunTotals.matchedJobs}</b><span>Matched this search</span><small>new jobs English-confirmed and meeting criteria then</small></div>
              <div><b>{collectionView ? collectionView.total : '—'}</b><span>Total collected</span><small>unique retained jobs, this and previous searches</small></div>
            </div>}
            {latestRun && latestRunTotals.matchedUnknown && <p className="source-dashboard-explainer">
              Matched is unknown for at least one contacted source that did not complete or predates
              matched tracking — shown as — rather than as a false zero.</p>}
            {collectionView && <p className="source-dashboard-explainer">{TOTALS_DEDUPE_NOTE}</p>}
            {latestRun && <div className="source-report-grid">
              {[...latestRun.sources]
                .sort((a, b) => SOURCE_RUN_STATUS_RANK[a.status] - SOURCE_RUN_STATUS_RANK[b.status]
                  || a.sourceName.localeCompare(b.sourceName))
                .map((source) => {
                  // New and Matched are run snapshots: only completed sources carry
                  // numbers. Anything else is unknown (—), never a false zero.
                  // Total collected is server-retained and stays known across runs.
                  const completed = source.status === 'complete' || source.status === 'partial';
                  const newDisplay = completed ? `${source.importedCount}` : '—';
                  const matchedDisplay = completed ? formatCountOrUnknown(source.matchedCount) : '—';
                  const collected = collectionView ? totalForSource(collectionView.bySource, source.sourceKey) : null;
                  return <article className={`source-report ${source.status}`} key={source.sourceKey}>
                <div className="source-top"><span>{countryLabel(source.country)}</span><span className={`source-status ${source.status}`}><i aria-hidden="true" />{sourceRunStatusLabel(source.status)}</span></div>
                <h3>{source.sourceName}</h3>
                <div className="source-cells">
                  <div><b className={!completed || source.importedCount === 0 ? 'is-zero' : ''} title={completed ? 'First-time unique jobs this run added to this account.' : 'This source did not complete, so new jobs are unknown rather than zero.'}>{newDisplay}</b><span>New this search</span></div>
                  <div className={completed && (source.matchedCount ?? 0) > 0 ? 'is-added' : ''}><b className={matchedDisplay === '—' || matchedDisplay === '0' ? 'is-zero' : ''} title="New jobs that were English-confirmed and met the saved criteria at search time. A snapshot; later corrections do not rewrite it.">{matchedDisplay}</b><span>Matched this search</span></div>
                  <div><b title="Unique retained jobs attributed to this source, this and previous searches. Saved, applied and dismissed rows are included; deleted rows are gone.">{collected == null ? '—' : collected}</b><span>Total collected</span></div>
                </div>
                {source.status !== 'complete' && source.message.trim() && <p className="source-message">{source.message}</p>}
              </article>;})}
            </div>}
            {!latestRun && collectionView && collectionView.total > 0 && <p className="source-dashboard-explainer">
              No search has run yet in this view, but {collectionView.total} unique retained job{collectionView.total === 1 ? '' : 's'} from
              previous searches or imports {collectionView.total === 1 ? 'is' : 'are'} still collected.</p>}
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
      </div>

      <section className="results" id="jobs">
        {/* UX-6f: no eyebrow above the heading. "Your workspace / Screened jobs"
            repeats the hero directly above it; the counts line is the part that
            says something, so the heading stands alone on every width. */}
        <div className="section-heading"><div><h2>Screened jobs</h2></div><span className="status-note">{loading ? 'Loading…'
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
            <summary>Filters<span>{DASHBOARD_VIEW_LABELS[view]}{languageApplies && languageFilter !== 'all' ? ` · ${LANGUAGE_FILTER_LABELS[languageFilter]}` : ''}</span></summary>
            {/* Lifecycle tabs live above the list; this column keeps the facets. */}
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
          {/* The view goes on the list so the stylesheet can tell the two cases apart. In
              "New" every job is unseen by definition - 140 of 140 - so the unseen marker is
              on every card and distinguishes nothing while being the loudest thing in the
              list. It earns its place in the views where seen and unseen actually mix. */}
          <div className={`job-list view-${view}`}>
            {/* The tabs, quiet links and sort share one row at desktop width: the segmented
                tabs on the left, the quiet links and sort on the right. Below 850px the row
                stacks with the tabs full width. Each language verdict is individually
                reachable through the language selector below; dismissed jobs wait behind
                an undo note plus their own quiet link. */}
            <div className="results-controls">
            <div className="view-tabs" role="group" aria-label="Result age and pipeline">
              <button type="button" className={view === 'new' ? 'active' : ''} onClick={() => setView('new')} title="Jobs first seen since the last search. The language choice below narrows this list."><span>New</span><i>{counts.new}</i></button>
              <button type="button" className={view === 'all' ? 'active' : ''} onClick={() => setView('all')} title="Every saved result, not just what is new. The language choice below narrows this list."><span>All</span><i>{counts.all}</i></button>
              <button type="button" className={view === 'pipeline' ? 'active' : ''} onClick={() => setView('pipeline')} title="Everything you saved or marked applied, whatever the language screen says."><span>Pipeline</span><i>{counts.pipeline}</i></button>
            </div>
            <div className="results-side">
            <div className="quiet-links">
              <button type="button" className={view === 'dismissed' ? 'active' : ''} onClick={() => setView('dismissed')}>
                {counts.dismissed ? `Dismissed (${counts.dismissed})` : 'Dismissed'}
              </button>
            </div>
              <label className="sort-control"><span>Sort</span><select
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as SortMode)}
              >{(Object.keys(SORT_MODE_LABELS) as SortMode[]).map((mode) => <option value={mode} key={mode}>{SORT_MODE_LABELS[mode]}</option>)}</select></label>
            </div>
            </div>
            {/* Explicit language filters (#119), separate from the lifecycle tabs above.
                The screen is a best-effort gate, not a promise of perfect classification:
                counts are loaded-page rows in this view, and a correction moves the card. */}
            {languageApplies ? <div className="language-tabs" role="group" aria-label="Language">
              {(Object.keys(LANGUAGE_FILTER_LABELS) as LanguageFilter[]).map((option) => <button
                key={option}
                type="button"
                className={languageFilter === option ? 'active' : ''}
                aria-pressed={languageFilter === option}
                onClick={() => setLanguageFilter(option)}
                title={option === 'all'
                  ? 'Every verdict, including ads that need a local language.'
                  : option === 'blocked'
                    ? 'Only ads that need a local language. Nothing here is promoted to a match.'
                    : `Only ads screened as ${LANGUAGE_FILTER_LABELS[option].toLowerCase()}.`}
              ><span>{LANGUAGE_FILTER_LABELS[option]}</span><i>{languageCounts[option]}</i></button>)}
            </div> : <p className="language-note" role="note">Pipeline and Dismissed show everything you put there, whatever the language screen says.</p>}
            {/* One filter surface: every active constraint as a removable pill, saved
                keywords first. "Clear all" appears once there is more than one. */}
            {pills.length > 0 && <div className="list-toolbar">
              <div className="pills" aria-label="Active filters">
                {pills.map((pill) => <button
                  key={pill.key}
                  type="button"
                  className="pill"
                  onClick={() => removePill(pill.key)}
                  title={pill.key === 'required' || pill.key === 'excluded'
                    ? 'Remove these keywords from your saved criteria'
                    : pill.key === 'language'
                      ? 'Show all language results'
                      : 'Remove this filter'}
                ><span>{pill.label}</span><i aria-hidden="true">×</i></button>)}
                {pills.length > 1 && <button type="button" className="pill-clear" onClick={clearAllFilters}>Clear all</button>}
              </div>
            </div>}
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
              const copy = emptyStateCopy(view, languageApplies ? languageFilter : 'all', {
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
              const displayedLanguageStatus = effectiveLanguageStatus(job);
              const requirements = job.requirements;
              const hasCorrection = job.languageFeedback === 'incorrect' && Boolean(job.correctedLanguageStatus);
              const feedbackDraft = feedbackDrafts[job.id] ?? {
                correctedStatus: job.correctedLanguageStatus || (job.languageStatus === 'pass' ? 'review' : 'pass'),
                reason: job.languageFeedbackReason,
              };
              // Where every card in view shares the chosen verdict, the chip only
              // restates the filter, so the English-confirmed chip hides under an
              // English-confirmed filter and is kept everywhere else (#119).
              const showLanguageChip = !(languageApplies && languageFilter === 'pass' && displayedLanguageStatus === 'pass');
              const { place: jobCity } = normalizePlace(job.location);
              const sourceDisplayName = job.sourceName || sourceNameForUrl(job.sourceUrl);
              const applied = job.applicationStatus === 'applied';
              // #97: derived from the stored end date, no request. The card stays - the person
              // may have applied - but it must not look current when the advertisement is gone.
              const expired = isJobExpired(job);
              const closing = !expired && closesToday(job);
              // UX-6b: a preview too short to judge carries no stated requirements, which
              // reads differently from a full advertisement that states none under a
              // heading the extractor knows - the two must not look alike.
              const isPreview = !requirements && job.descriptionLength < MIN_CHARS_TO_CONFIRM_ENGLISH;
              // The unseen accent edge is #46's; the verdict's own edge is untouched by it.
              return <article className={`job-card ${displayedLanguageStatus}${openedJobs.has(job.id) ? '' : ' is-unseen'}${selectedJobIds.includes(job.id) ? ' is-selected' : ''}`} key={job.id}>
                <div className="score-column"><label className="job-select"><input type="checkbox" aria-label="Select this job" checked={selectedJobIds.includes(job.id)} onChange={() => toggleJobSelection(job.id)} /></label></div>
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
                  {/* The densest line on the card used to spend two of its five slots saying
                      what we do not know - "Company not added", "Work type unknown" - on every
                      card, and there are a hundred and forty of them. An absent company reads as
                      absent, and work type has its own filter for the people who care. The
                      posting date keeps its unavailable form, because on this product a date we
                      cannot vouch for is a warning, not noise. */}
                  <p className="job-subline">{[
                    job.company,
                    jobCity || job.location,
                    formatDate(job.postedAt).replace(/^Posted /, ''),
                    job.workplaceType === 'unknown' ? '' : workplaceLabel(job.workplaceType),
                    countryLabel(job.country),
                  ].filter(Boolean).join(' · ')}</p>
                  {/* Tier 2 — Judge: the verdict chips. The verdict reason stays visible
                      underneath (the language decision is never shown without its reason). */}
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
                  {/* UX-6b: on a pass the chip already says Definitely English and a
                      sentence repeating it adds nothing; on every other verdict the
                      reason earns its place under the chips. */}
                  {displayedLanguageStatus !== 'pass' && job.languageSummary
                    && <p className="language-summary">{hasCorrection ? `Detector note: ${job.languageSummary}` : job.languageSummary}</p>}
                  {/* Tier 3 — Act: one filled pill naming the destination, an outline save
                      icon, an applied checkbox, and everything else behind the "…" menu. */}
                  <div className="act-row">
                    <a
                      className={`apply-link${displayedLanguageStatus === 'blocked' ? ' ghost' : ''}`}
                      href={job.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      title={expired ? `This advertisement closed on ${job.expiresAt.slice(0, 10)} — the page may say it is no longer active.` : undefined}
                      onClick={() => { openedApply.current.set(job.id, sourceDisplayName); markJobOpened(job.id); }}
                    >{displayedLanguageStatus === 'blocked' ? `Open on ${sourceDisplayName} ↗` : `Apply on ${sourceDisplayName} ↗`}</a>
                    <button
                      type="button"
                      className={`save-icon ${job.isSaved ? 'selected' : ''}`}
                      aria-pressed={job.isSaved}
                      aria-label={job.isSaved ? 'Saved — remove from Pipeline' : 'Save to Pipeline'}
                      title={job.isSaved ? 'Saved — remove from Pipeline' : 'Save to Pipeline'}
                      onClick={() => updateJobState(job.id, { isSaved: !job.isSaved })}
                    >{job.isSaved ? '♥' : '♡'}</button>
                    {/* Canvas state 4: a blocked card is dimmed and carries no
                        Applied toggle — there is nothing to apply for. */}
                    {displayedLanguageStatus !== 'blocked' && <label className="applied-check" title="Tick once you have applied on the job site">
                      <input
                        type="checkbox"
                        checked={applied}
                        onChange={() => updateJobState(job.id, { applicationStatus: applied ? 'not_applied' : 'applied' })}
                      />
                      <span>Applied</span>
                    </label>}
                    <details className="card-menu">
                      <summary aria-label="More actions for this job">…</summary>
                      <div className="card-menu-body">
                        <button type="button" onClick={() => updateJobState(job.id, { visibilityStatus: job.visibilityStatus === 'dismissed' ? 'active' : 'dismissed' })}>{job.visibilityStatus === 'dismissed' ? 'Restore' : 'Dismiss'}</button>
                        <div className="card-menu-feedback">
                          <span>Was the language result right?</span>
                          <button type="button" className={job.languageFeedback === 'correct' ? 'selected' : ''} disabled={feedbackBusy === job.id} onClick={() => saveLanguageFeedback(job, 'correct')}>✓ Accurate</button>
                          <button type="button" className={`report-link${job.languageFeedback === 'incorrect' ? ' selected' : ''}`} disabled={feedbackBusy === job.id} onClick={() => openFeedbackCorrection(job)}>Flag wrong</button>
                          {job.languageFeedback && <button type="button" disabled={feedbackBusy === job.id} onClick={() => saveLanguageFeedback(job, '')}>Clear</button>}
                          {feedbackMessages[job.id] && <small aria-live="polite">{feedbackMessages[job.id]}</small>}
                        </div>
                        {feedbackOpen[job.id] && <div className="feedback-form">
                          <label><span>Correct result</span><select value={feedbackDraft.correctedStatus} onChange={(event) => updateFeedbackDraft(job.id, { correctedStatus: event.target.value as LanguageStatus })}><option value="pass">Definitely English</option><option value="unknown">Not sure</option><option value="review">Maybe English</option><option value="blocked">Local language required</option></select></label>
                          <label><span>Reason (optional)</span><input maxLength={500} value={feedbackDraft.reason} onChange={(event) => updateFeedbackDraft(job.id, { reason: event.target.value })} placeholder="e.g. German is only a plus" /></label>
                          <button type="button" disabled={feedbackBusy === job.id} onClick={() => saveLanguageFeedback(job, 'incorrect', feedbackDraft.correctedStatus, feedbackDraft.reason)}>Save correction</button>
                        </div>}
                      </div>
                    </details>
                  </div>
                  {jobFlash[job.id] && <p className="card-flash" role="status">{jobFlash[job.id]}</p>}
                </div>
                {/* UX-6b + #125: what the employer asks for holds the right side.
                    Extracted from the available advertisement — a grounded quotation,
                    never a CV-match explanation and never a language-eligibility claim.
                    The source heading is preserved verbatim ("Nice to have" stays
                    optional; it is never flattened to a bare "Asks for").
                    A preview too short to judge says so; a full ad with nothing
                    reliably extractable says it could not be extracted (not that the
                    employer asks for nothing). Both point at the original page. */}
                <div className="job-requirements">
                  {requirements
                    ? <><span>{formatRequirementsRailLabel(requirements.heading)}</span>
                      <ul>{requirements.items.slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul>
                      {requirements.items.length > 3 && <details className="requirements-more">
                        <summary>Show all {requirements.items.length} requirements</summary>
                        <ul>{requirements.items.slice(3).map((item) => <li key={item}>{item}</li>)}</ul>
                      </details>}
                      <p className="requirements-note">Extracted from the available advertisement — not a complete guarantee. <a href={job.sourceUrl} target="_blank" rel="noreferrer">Original ad on {sourceDisplayName} ↗</a></p>
                    </>
                    : isPreview
                      ? <><span>Requirements not published</span><p>{sourceDisplayName} published a preview rather than the full advertisement. The requirements are on the <a href={job.sourceUrl} target="_blank" rel="noreferrer">original page ↗</a>.</p></>
                      : <><span>Asks for</span><p>Could not extract requirements from the available text — the employer may still list them. See the <a href={job.sourceUrl} target="_blank" rel="noreferrer">original ad ↗</a>.</p></>}
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
          <p>An ad too short to judge goes to <b>Not sure</b>, not to your matches. Anything that names a language without clearly requiring it goes to <b>Maybe English</b>. You apply on the original job site yourself.</p>
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

      <footer><b>Ik ben een appel</b><span>An English job-search filter for people who do not speak Dutch · you apply yourself, always</span><a href="#sources" onClick={() => setStatsOpen(true)}>Source report ↑</a><a href="/sources">Where the jobs come from →</a><a href="/privacy">Privacy</a></footer>
    </main>
  );
}
