'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { defaultSearchCriteria, matchesSearchCriteria, parseKeywordInput, roleForProfile } from '@/lib/criteria';
import type { AppState, CvSlot, JobRecord, JobStatus, SearchCriteria } from '@/lib/types';

type View = 'matches' | 'review' | 'pipeline' | 'all';

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

const emptySlotState: SlotState = { file: null, text: '', busy: false, message: '' };
const emptyImport = { sourceUrl: '', title: '', company: '', location: '', description: '' };
const slots: CvSlot[] = ['a', 'b'];
const slotLabels: Record<CvSlot, string> = { a: 'CV 1', b: 'CV 2' };

function criteriaToDraft(criteria: SearchCriteria): CriteriaDraft {
  return {
    roleOverrideA: criteria.roleOverrideA,
    roleOverrideB: criteria.roleOverrideB,
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

function statusLabel(status: JobStatus) {
  if (status === 'new') return 'New';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function bestFitScore(job: JobRecord) {
  return Math.max(job.fitScoreA, job.fitScoreB);
}

export default function JobRadar() {
  const [state, setState] = useState<AppState>({ profiles: [], jobs: [], criteria: defaultSearchCriteria });
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('matches');
  const [cvSlots, setCvSlots] = useState<Record<CvSlot, SlotState>>({ a: { ...emptySlotState }, b: { ...emptySlotState } });
  const [importData, setImportData] = useState(emptyImport);
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [scrapeBusy, setScrapeBusy] = useState(false);
  const [scrapeMessage, setScrapeMessage] = useState('');
  const [criteriaDraft, setCriteriaDraft] = useState<CriteriaDraft>(criteriaToDraft(defaultSearchCriteria));
  const [criteriaBusy, setCriteriaBusy] = useState(false);
  const [criteriaMessage, setCriteriaMessage] = useState('');
  const importRef = useRef<HTMLElement>(null);

  useEffect(() => {
    fetch('/api/state')
      .then((response) => responseJson<AppState>(response))
      .then((next) => {
        const criteria = next.criteria ?? defaultSearchCriteria;
        setState({ ...next, criteria });
        setCriteriaDraft(criteriaToDraft(criteria));
      })
      .catch((error: Error) => setScrapeMessage(error.message))
      .finally(() => setLoading(false));
  }, []);

  const hasAnyCv = state.profiles.some((profile) => profile.hasCvText);
  const primaryProfile = state.profiles.find((profile) => profile.derivedRole);
  const primaryRole = primaryProfile ? roleForProfile(primaryProfile, state.criteria) : '';

  const criteriaFilteredJobs = useMemo(
    () => state.jobs.filter((job) => matchesSearchCriteria(job, state.criteria)),
    [state.jobs, state.criteria],
  );

  const counts = useMemo(() => ({
    matches: criteriaFilteredJobs.filter((job) => job.languageStatus === 'pass' && job.status !== 'ignored').length,
    review: criteriaFilteredJobs.filter((job) => job.languageStatus === 'review' && job.status !== 'ignored').length,
    pipeline: state.jobs.filter((job) => job.status === 'saved' || job.status === 'applied').length,
  }), [criteriaFilteredJobs, state.jobs]);

  const visibleJobs = useMemo(() => state.jobs.filter((job) => {
    const matchesCriteria = matchesSearchCriteria(job, state.criteria);
    if (view === 'matches') return matchesCriteria && job.languageStatus === 'pass' && job.status !== 'ignored';
    if (view === 'review') return matchesCriteria && job.languageStatus === 'review' && job.status !== 'ignored';
    if (view === 'pipeline') return job.status === 'saved' || job.status === 'applied';
    return matchesCriteria && job.status !== 'ignored';
  }).sort((a, b) => bestFitScore(b) - bestFitScore(a)), [state.criteria, state.jobs, view]);

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

  function openImport() {
    setShowImport(true);
    requestAnimationFrame(() => importRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  async function addJob(event: FormEvent) {
    event.preventDefault();
    setImportBusy(true);
    setImportMessage('Checking the ad language and CV fit…');
    try {
      const result = await responseJson<{ job: JobRecord }>(await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(importData),
      }));
      setState((current) => ({ ...current, jobs: [result.job, ...current.jobs.filter((job) => job.id !== result.job.id)] }));
      setImportData(emptyImport);
      setImportMessage(result.job.languageSummary);
      setView(result.job.languageStatus === 'pass' ? 'matches' : result.job.languageStatus === 'review' ? 'review' : 'all');
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : 'Could not analyze this job.');
    } finally {
      setImportBusy(false);
    }
  }

  async function findJobs() {
    setScrapeBusy(true);
    setScrapeMessage('Searching jobs.ch…');
    try {
      const result = await responseJson<{ added: JobRecord[]; scanned: number; alreadyKnown: number }>(
        await fetch('/api/scrape', { method: 'POST' }),
      );
      setState((current) => ({
        ...current,
        jobs: [...result.added, ...current.jobs.filter((job) => !result.added.some((added) => added.id === job.id))],
      }));
      setScrapeMessage(result.added.length
        ? `Found ${result.added.length} new job${result.added.length === 1 ? '' : 's'} (${result.alreadyKnown} already known).`
        : `No new jobs found (${result.alreadyKnown} already known).`);
    } catch (error) {
      setScrapeMessage(error instanceof Error ? error.message : 'Could not search jobs.ch.');
    } finally {
      setScrapeBusy(false);
    }
  }

  async function updateStatus(id: string, status: JobStatus) {
    const previous = state.jobs;
    setState((current) => ({ ...current, jobs: current.jobs.map((job) => job.id === id ? { ...job, status } : job) }));
    try {
      await responseJson(await fetch(`/api/jobs/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      }));
    } catch {
      setState((current) => ({ ...current, jobs: previous }));
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="#top"><span className="brand-mark">N</span><span><b>Northbound</b><small>Swiss job radar</small></span></a>
        <nav aria-label="Main navigation"><a className="active" href="#jobs">Matches</a><a href="#profile">My CVs</a><a href="#pipeline">Pipeline</a></nav>
        <span className="source-pill"><i /> Source: jobs.ch</span>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <span className="eyebrow">English-only roles · Switzerland</span>
          <h1>Less searching.<br /><em>More fitting.</em></h1>
          <p>Use jobs.ch normally, then let this private workspace reject ads that require German, French, Italian or Dutch and rank the rest against your CVs.</p>
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
          <p>Unclear ads go to Review. Applications stay on jobs.ch, where you can sign in yourself.</p>
        </aside>
      </section>

      <section className="profile-section" id="profile">
        <div className="profile-intro"><span className="section-label">Step one</span><h2>Upload up to two CVs</h2><p>Each CV is stored privately. We detect a likely target role from its content and search jobs.ch for both roles.</p></div>
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
                <button className="search-button" type="submit" disabled={local.busy}>{local.busy ? 'Saving…' : saved ? 'Update' : 'Save'}</button>
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
          <p>Role overrides and location shape the jobs.ch search. Every field filters your local result views; Pipeline always keeps saved and applied jobs visible.</p>
        </div>
        <form className="criteria-form" onSubmit={saveCriteria}>
          <label className="field"><span>CV 1 role override</span><input value={criteriaDraft.roleOverrideA} onChange={(event) => setCriteriaDraft({ ...criteriaDraft, roleOverrideA: event.target.value })} placeholder={state.profiles.find((profile) => profile.slot === 'a')?.derivedRole || 'Use detected role'} /></label>
          <label className="field"><span>CV 2 role override</span><input value={criteriaDraft.roleOverrideB} onChange={(event) => setCriteriaDraft({ ...criteriaDraft, roleOverrideB: event.target.value })} placeholder={state.profiles.find((profile) => profile.slot === 'b')?.derivedRole || 'Use detected role'} /></label>
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
        <div className="workflow-copy"><span className="section-label coral">Step two</span><h2>Search on jobs.ch</h2><p>Run an automatic search for your detected roles, open a targeted search yourself, or paste one ad by hand. Log in on jobs.ch directly if needed.</p></div>
        <div className="workflow-steps"><span><b>1</b> Find or open a search</span><span><b>2</b> Screen for English</span><span><b>3</b> Review your matches</span></div>
        <button className="jobs-button" type="button" disabled={!hasAnyCv || scrapeBusy} onClick={findJobs}>{scrapeBusy ? 'Searching…' : 'Find new jobs'} <span>⟳</span></button>
        <a className={`jobs-button ${!hasAnyCv ? 'disabled' : ''}`} href={jobsSearchUrl(primaryRole, state.criteria.location)} target={hasAnyCv ? '_blank' : undefined} rel="noreferrer">Open jobs.ch <span>↗</span></a>
        <button className="import-button" type="button" disabled={!hasAnyCv} onClick={openImport}>Analyze a job <span>＋</span></button>
        <p className="form-message" aria-live="polite">{scrapeMessage}</p>
      </section>

      {showImport && <section className="import-panel" ref={importRef}>
        <div className="import-heading"><div><span className="section-label">Strict screening</span><h2>Paste one jobs.ch advertisement</h2></div><button type="button" onClick={() => setShowImport(false)} aria-label="Close import form">×</button></div>
        <form onSubmit={addJob}>
          <label className="field wide"><span>jobs.ch job URL</span><input type="url" value={importData.sourceUrl} onChange={(event) => setImportData({ ...importData, sourceUrl: event.target.value })} placeholder="https://www.jobs.ch/en/vacancies/detail/…" required /></label>
          <label className="field"><span>Job title</span><input value={importData.title} onChange={(event) => setImportData({ ...importData, title: event.target.value })} required /></label>
          <label className="field"><span>Company</span><input value={importData.company} onChange={(event) => setImportData({ ...importData, company: event.target.value })} /></label>
          <label className="field"><span>Location</span><input value={importData.location} onChange={(event) => setImportData({ ...importData, location: event.target.value })} placeholder="e.g. Zürich / Remote" /></label>
          <label className="field wide"><span>Full job advertisement</span><textarea value={importData.description} onChange={(event) => setImportData({ ...importData, description: event.target.value })} placeholder="Copy the title, responsibilities, requirements and language section from the open ad…" rows={11} required /></label>
          <div className="import-footer"><p aria-live="polite">{importMessage || 'The complete text is needed to distinguish “required” from “nice to have.”'}</p><button className="primary" type="submit" disabled={importBusy}>{importBusy ? 'Analyzing…' : 'Analyze & add'}</button></div>
        </form>
      </section>}

      <section className="results" id="jobs">
        <div className="section-heading"><div><span className="section-label coral">Your workspace</span><h2>Screened jobs</h2></div><span className="status-note">{loading ? 'Loading…' : `${state.jobs.length} analyzed`}</span></div>
        <div className="result-layout">
          <aside className="filters" id="pipeline">
            <b>Views</b>
            <button className={view === 'matches' ? 'active' : ''} onClick={() => setView('matches')}><span>English matches</span><i>{counts.matches}</i></button>
            <button className={view === 'review' ? 'active' : ''} onClick={() => setView('review')}><span>Needs review</span><i>{counts.review}</i></button>
            <button className={view === 'pipeline' ? 'active' : ''} onClick={() => setView('pipeline')}><span>Pipeline</span><i>{counts.pipeline}</i></button>
            <button className={view === 'all' ? 'active' : ''} onClick={() => setView('all')}><span>All matching</span><i>{criteriaFilteredJobs.filter((job) => job.status !== 'ignored').length}</i></button>
          </aside>
          <div className="job-list">
            {!loading && visibleJobs.length === 0 && <div className="empty-state"><span>◎</span><h3>{hasAnyCv ? 'No jobs in this view yet' : 'Start with your CV'}</h3><p>{hasAnyCv ? 'Open jobs.ch, copy a promising ad, then run the strict language check.' : 'Upload a CV to unlock search, screening and match scores.'}</p>{hasAnyCv && <button type="button" onClick={openImport}>Analyze your first job</button>}</div>}
            {visibleJobs.map((job) => {
              const bothCvsSaved = state.profiles.filter((profile) => profile.hasCvText).length > 1;
              return <article className={`job-card ${job.languageStatus}`} key={job.id}>
                <div className="score"><strong>{bestFitScore(job)}</strong><span>CV fit</span></div>
                <div className="job-body">
                  <div className="job-topline"><span className="job-meta">{job.company || 'Company not added'} · {job.location}</span><span className={`language-badge ${job.languageStatus}`}>{job.languageStatus === 'pass' ? 'English sufficient' : job.languageStatus === 'review' ? 'Review language' : 'Local language required'}</span></div>
                  <h3>{job.title}</h3><p className="language-summary">{job.languageSummary}</p>
                  {bothCvsSaved && <p className="fit-breakdown">
                    {state.profiles.filter((profile) => profile.hasCvText).map((profile) => `${roleForProfile(profile, state.criteria) || slotLabels[profile.slot]}: ${profile.slot === 'a' ? job.fitScoreA : job.fitScoreB}`).join(' · ')}
                  </p>}
                  <div className="tags">{job.matchedKeywords.slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}{!job.matchedKeywords.length && <span>No clear CV overlap yet</span>}</div>
                  <div className="card-actions"><button type="button" className={job.status === 'saved' ? 'selected' : ''} onClick={() => updateStatus(job.id, job.status === 'saved' ? 'new' : 'saved')}>♡ {job.status === 'saved' ? 'Saved' : 'Save'}</button><button type="button" className={job.status === 'applied' ? 'selected' : ''} onClick={() => updateStatus(job.id, 'applied')}>✓ {job.status === 'applied' ? 'Applied' : 'Mark applied'}</button><button type="button" onClick={() => updateStatus(job.id, 'ignored')}>Hide</button></div>
                </div>
                <a className="apply-link" href={job.sourceUrl} target="_blank" rel="noreferrer">Apply on jobs.ch ↗</a>
                <span className="status-chip">{statusLabel(job.status)}</span>
              </article>;
            })}
          </div>
        </div>
      </section>

      <footer><b>Northbound MVP</b><span>One source · strict English gate · user-controlled applications</span><a href="https://www.jobs.ch/en/terms/" target="_blank" rel="noreferrer">jobs.ch terms ↗</a></footer>
    </main>
  );
}
