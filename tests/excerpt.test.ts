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

test('a Dutch advertisement states its requirements as questions', () => {
  const ad = 'Wij zijn een middelgroot logistiek bedrijf met klanten in heel Europa en een product waarop men vertrouwt.\n\n'
    + 'Ben jij een leidinggevende die energie krijgt van dynamiek en verantwoordelijkheid?\n\n'
    + 'Heb jij ervaring binnen supply chain en kun je goed analyseren en rapporteren aan het team?';
  const excerpt = jobExcerpt(ad, null);
  assert.equal(excerpt?.source, 'asked');
  assert.match(excerpt!.text, /Ben jij een leidinggevende/);
  assert.match(excerpt!.text, /ervaring binnen supply chain/);
  assert.doesNotMatch(excerpt!.text, /middelgroot logistiek bedrijf/,
    'the company description is not what the reader is judging themselves against');
});

test('Dutch requirement forms beyond the question are quoted', () => {
  const ad = 'Daarnaast beschik je over aantoonbare ervaring als planner in een productieomgeving met SAP.\n\n'
    + 'De functie-eisen zijn een afgeronde mbo-opleiding en je bent in het bezit van een rijbewijs.';
  const excerpt = jobExcerpt(ad, null);
  assert.equal(excerpt?.source, 'asked');
  assert.match(excerpt!.text, /aantoonbare ervaring als planner/);
  assert.match(excerpt!.text, /afgeronde mbo-opleiding/);
});

test('a Dutch working week and duties are not requirements', () => {
  // 'minimaal' also counts the hours ("minimaal 16 uur per week") and 'je bent' states duties
  // ("je bent verantwoordelijk voor"), so neither is a cue: without one the card falls back to
  // the role line rather than presenting hours as what the job asks for.
  const ad = 'Je bent verantwoordelijk voor de dagelijkse planning en rapportage aan het team.\n\n'
    + 'De werkweek is 32 uur, minimaal 16 uur per week.';
  const excerpt = jobExcerpt(ad, null);
  assert.equal(excerpt?.source, 'role');
});

test('a French advertisement states its requirements plainly', () => {
  const ad = 'Pour l\u2019un de nos clients bas\u00e9 \u00e0 Lausanne, nous recherchons un supply chain manager exp\u00e9riment\u00e9.\n\n'
    + 'Vous justifiez d\u2019une exp\u00e9rience de 3 ans dans la logistique et vous ma\u00eetrisez les outils SAP.\n\n'
    + 'Profil recherch\u00e9 : au b\u00e9n\u00e9fice d\u2019une formation sup\u00e9rieure en supply chain ou \u00e9quivalent.';
  const excerpt = jobExcerpt(ad, null);
  assert.equal(excerpt?.source, 'asked');
  assert.match(excerpt!.text, /nous recherchons/);
  assert.match(excerpt!.text, /justifiez/);
  assert.match(excerpt!.text, /Profil recherch\u00e9/);
  assert.match(excerpt!.text, /formation sup\u00e9rieure/);
});

test('French benefits and application prose are not requirements', () => {
  // Bare 'de formation' matches "possibilit\u00e9s de formation continue" and bare 'dipl\u00f4me'
  // matches "vos dipl\u00f4mes", so only the qualified forms are cues.
  const ad = 'Vous justifiez d\u2019une exp\u00e9rience de 3 ans dans la logistique et la planification des flux.\n\n'
    + 'Des possibilit\u00e9s de formation continue et de d\u00e9veloppement personnel sont offertes \u00e0 tous les employ\u00e9s.\n\n'
    + 'Merci d\u2019adresser votre dossier de candidature complet avec votre curriculum vitae et vos dipl\u00f4mes.';
  const excerpt = jobExcerpt(ad, null);
  assert.equal(excerpt?.source, 'asked');
  assert.match(excerpt!.text, /justifiez/);
  assert.doesNotMatch(excerpt!.text, /formation continue/);
  assert.doesNotMatch(excerpt!.text, /dipl\u00f4mes/);
});

test('German requirement forms beyond the original list are quoted', () => {
  const ad = 'Wir suchen eine erfahrene Pers\u00f6nlichkeit f\u00fcr unser Supply Chain Team in Z\u00fcrich.\n\n'
    + 'Du verf\u00fcgst idealerweise \u00fcber mehrj\u00e4hrige Berufserfahrung in Logistik und hast ein abgeschlossenes Studium.';
  const excerpt = jobExcerpt(ad, null);
  assert.equal(excerpt?.source, 'asked');
  assert.match(excerpt!.text, /Wir suchen/);
  assert.match(excerpt!.text, /Berufserfahrung/);
});

test('English purchase orders are not Italian requirements', () => {
  // "Process requisitions" contains 'requisiti', so that stem can never be a cue.
  const ad = 'We run inbound supply for three manufacturing sites across Europe and keep every line fed.\n\n'
    + 'You will process requisitions, place purchase orders globally and manage vendor inventory.';
  const excerpt = jobExcerpt(ad, null);
  assert.equal(excerpt?.source, 'role');
});

test('a Dutch section label glued to the sentence is removed, not shown', () => {
  // Stripping HTML turns "<h3>Dit ga je doen</h3><p>Ben jij…</p>" into one line, the same
  // defect the English glued labels were added for.
  const excerpt = jobExcerpt('Dit ga je doen Ben jij een leidinggevende die energie krijgt van dynamiek en verantwoordelijkheid?', null);
  assert.ok(excerpt);
  assert.doesNotMatch(excerpt!.text, /^Dit ga je doen/);
  assert.match(excerpt!.text, /^Ben jij een leidinggevende/);
});

test('a German profile label glued to the sentence is removed, not shown', () => {
  const excerpt = jobExcerpt('Dein Profil Du verfügst über ausgewiesene Erfahrung als Business Analyst und hast steuerrechtliches Fachwissen.', null);
  assert.ok(excerpt);
  assert.doesNotMatch(excerpt!.text, /^Dein Profil/);
  assert.match(excerpt!.text, /^Du verf\u00fcgst/);
});
