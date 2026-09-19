import assert from 'node:assert/strict';
import test from 'node:test';
import { jobExcerpt, MAX_EXCERPT_CHARS } from '../lib/excerpt';

const AD = `About us

We are a mid-sized logistics company with customers across Europe and a product people rely on.

The role

You will own the reporting estate for our operations team and work closely with finance.

What we ask

You have 3+ years of experience with SQL and a degree in a numerate subject.
Experience with Power BI is a strong advantage.
You are comfortable presenting to senior stakeholders.

What we offer

A permanent contract, a training budget and twenty-six days of holiday.`;

test('the employer own requirements list is used when there is one', () => {
  const excerpt = jobExcerpt(AD, { heading: 'What we ask', items: ['3+ years of SQL', 'A numerate degree'] });
  assert.equal(excerpt?.source, 'requirements');
  assert.match(excerpt!.text, /3\+ years of SQL/);
  assert.match(excerpt!.text, /numerate degree/);
});

test('without a requirements heading it quotes what is actually asked, not the company blurb', () => {
  const excerpt = jobExcerpt(AD, null);
  assert.equal(excerpt?.source, 'asked');
  assert.match(excerpt!.text, /3\+ years of experience with SQL/);
  assert.doesNotMatch(excerpt!.text, /mid-sized logistics company/,
    'the company description is not what the reader is judging themselves against');
  assert.doesNotMatch(excerpt!.text, /twenty-six days of holiday/, 'benefits are not requirements');
});

test('an advertisement that asks for nothing falls back to what the job is, past the boilerplate', () => {
  const ad = `About us\n\nWe are a friendly company with a long history and a nice office.\n\n`
    + `The role\n\nYou will run the weekly reporting cycle and keep the dashboards honest for the operations team.`;
  const excerpt = jobExcerpt(ad, null);
  assert.equal(excerpt?.source, 'role');
  assert.match(excerpt!.text, /weekly reporting cycle/);
  assert.doesNotMatch(excerpt!.text, /friendly company/, 'the company opener is skipped');
});

test('nothing is invented when the advertisement carries no usable sentence', () => {
  assert.equal(jobExcerpt('', null), null);
  assert.equal(jobExcerpt('Apply now.', null), null, 'too short to say anything');
  assert.equal(jobExcerpt('   \n\n  ', null), null);
});

test('the excerpt stays within the cap and never ends mid-word', () => {
  const long = Array.from({ length: 30 },
    (_, i) => `You have experience with system number ${i} and its reporting toolchain.`).join('\n');
  const excerpt = jobExcerpt(long, null);
  assert.ok(excerpt);
  assert.ok(excerpt!.text.length <= MAX_EXCERPT_CHARS,
    `${excerpt!.text.length} characters exceeds the ${MAX_EXCERPT_CHARS} cap`);
  assert.doesNotMatch(excerpt!.text, /\s$/);
});

test('one very long requirement is trimmed at a word boundary rather than dropped', () => {
  const item = `You have ${'a very specific and lengthy qualification '.repeat(20)}`;
  const excerpt = jobExcerpt('', { heading: 'Requirements', items: [item] });
  assert.ok(excerpt);
  assert.ok(excerpt!.text.length <= MAX_EXCERPT_CHARS);
  assert.match(excerpt!.text, /…$/, 'a trimmed quotation says it was trimmed');
  assert.doesNotMatch(excerpt!.text, /\s…$/, 'the trim lands on a word, not a space');
});

test('prose about applying is never shown as what the job asks for', () => {
  // Real sentence from a stored advertisement. It matched the cue "you have" and was shown as a
  // requirement, which read as though the employer wanted someone with questions.
  const ad = 'If you have any question, please do not hesitate to contact our Talent Acquisition Team.\n\n'
    + 'You have five years of experience in demand planning and a degree in logistics.';
  const excerpt = jobExcerpt(ad, null);
  assert.equal(excerpt?.source, 'asked');
  assert.match(excerpt!.text, /five years of experience/);
  assert.doesNotMatch(excerpt!.text, /hesitate|Talent Acquisition/);
});

test('joined requirements respect the cap including their separators', () => {
  // Every over-cap excerpt measured on real jobs was exactly one character over: the separator is
  // three characters and the budget counted two.
  const items = Array.from({ length: 6 }, (_, i) => `Requirement number ${i} stated in about sixty characters here`);
  const excerpt = jobExcerpt('', { heading: 'Requirements', items });
  assert.ok(excerpt);
  assert.ok(excerpt!.text.length <= MAX_EXCERPT_CHARS,
    `${excerpt!.text.length} exceeds ${MAX_EXCERPT_CHARS}`);
});

test('an abbreviation does not cut the sentence in half', () => {
  const excerpt = jobExcerpt('Sie haben mehrjährige Erfahrung in einem datennahen Umfeld (z.B. Data Warehouse) und Freude daran.', null);
  assert.match(excerpt!.text, /Data Warehouse/);
});

test('a section label glued to the sentence is removed, not shown', () => {
  // Stripping HTML turns "<h3>Job Description</h3><p>We build…</p>" into one line.
  const excerpt = jobExcerpt('Job Description We are looking for a planner with experience in demand forecasting.', null);
  assert.ok(excerpt);
  assert.doesNotMatch(excerpt!.text, /^Job Description/);
  assert.match(excerpt!.text, /^We are looking for a planner/);
});

test('markup never reaches the card', () => {
  const excerpt = jobExcerpt('<ul><li>You have <strong>5 years</strong> of experience with SQL and dbt.</li></ul>', null);
  assert.ok(excerpt);
  assert.doesNotMatch(excerpt!.text, /[<>]/);
  assert.match(excerpt!.text, /5 years/);
});

test('a bare heading is never shown as if it were the answer', () => {
  const excerpt = jobExcerpt('Requirements\n\nWhat we offer\n\nYou have five years of experience in data engineering.', null);
  assert.equal(excerpt?.text, 'You have five years of experience in data engineering.');
});
