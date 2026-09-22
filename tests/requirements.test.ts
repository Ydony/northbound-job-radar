import assert from 'node:assert/strict';
import test from 'node:test';
import { extractRequirements, formatRequirementsRailLabel } from '../lib/requirements';

const ad = [
  'We are hiring a data analyst to join our team in Amsterdam.',
  'You will build reporting and work with stakeholders across the business.',
  'Your profile',
  '• University degree in a numerate subject',
  '• Three years of experience with SQL and Power BI',
  '• Comfortable presenting findings to senior stakeholders',
  'What we offer',
  '• A competitive salary and a training budget',
].join('\n');

test('pulls the requirements out from under their heading', () => {
  const result = extractRequirements(ad);
  assert.ok(result);
  assert.equal(result.heading, 'Your profile');
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0], 'University degree in a numerate subject');
});

test('stops at the next section rather than running into the offer', () => {
  // Showing what the employer gives you under a heading that says what they want is worse than
  // showing nothing: it reads as an answer and is not one.
  const result = extractRequirements(ad);
  assert.ok(result);
  assert.ok(!result.items.some((item) => /competitive salary/i.test(item)));
});

test('finds the requirements under "what we ask"', () => {
  // The literal translation of the Dutch 'wat wij vragen', which was already recognised while
  // the English was not (#84). The excerpt fixture uses it the same way, between the role and
  // the offer, so this is a heading that introduces what the employer asks for — never the
  // company, the offer, or the process.
  const asked = [
    'We are hiring a data analyst to join our team in Amsterdam.',
    'What we ask',
    '• University degree in a numerate subject',
    '• Three years of experience with SQL and Power BI',
    '• Comfortable presenting findings to senior stakeholders',
    'What we offer',
    '• A competitive salary and a training budget',
  ].join('\n');
  const result = extractRequirements(asked);
  assert.ok(result, 'an ad headed "What we ask" must yield requirements');
  assert.equal(result.heading, 'What we ask');
  assert.equal(result.items.length, 3);
  assert.ok(!result.items.some((item) => /competitive salary/i.test(item)));
});

test('strips the markdown rules Job-Room wraps its headings in', () => {
  const result = extractRequirements(ad.replace('Your profile', '### Your profile ###'));
  assert.equal(result?.heading, 'Your profile');
});

test('returns nothing rather than guessing', () => {
  // No heading at all.
  assert.equal(extractRequirements('A great role at a great company. Apply today.'), null);
  // A heading with a single line under it is a stray sentence, not a list - and showing one item
  // implies the job asks for one thing.
  assert.equal(extractRequirements('Requirements\n• Three years of relevant experience'), null);
  // A sentence that merely contains the word is not a heading; starting there would begin the
  // extract in the middle of a paragraph.
  assert.equal(extractRequirements(
    'We have adjusted our requirements for this role after speaking with the team about it.\n'
    + '• Something that looks like an item\n• And another one here',
  ), null);
});

test('splits paragraph sentences under a heading instead of dropping the block', () => {
  // #125: a requirements section written as prose rather than bullets. The old
  // line-only reader dropped the whole block for exceeding the per-item cap;
  // the sentences are quotable on their own.
  const para = [
    'We are hiring a data analyst in Amsterdam.',
    'Your profile',
    'You have a university degree in a numerate subject. You bring three years of experience with SQL and Power BI. You are comfortable presenting to senior stakeholders.',
    'What we offer',
    'A competitive salary.',
  ].join('\n');
  const result = extractRequirements(para);
  assert.ok(result, 'paragraph sentences under a heading must be extracted');
  assert.ok(result.items.length >= 2);
  assert.ok(result.items.some((item) => /university degree/i.test(item)));
  assert.ok(!result.items.some((item) => /competitive salary/i.test(item)));
});

test('finds requirements under an unfamiliar heading with requirement wording', () => {
  // #125: "Your must-haves" was never in the recognised list, but it is
  // unambiguously a requirements heading. Exact-list matching alone would miss it.
  const ad2 = [
    'We are hiring a data analyst.',
    'Your must-haves',
    '• University degree in a numerate subject',
    '• Three years of experience with SQL and Power BI',
    'What we offer',
    '• A competitive salary',
  ].join('\n');
  const result = extractRequirements(ad2);
  assert.ok(result, 'an unfamiliar requirements heading must still open the section');
  assert.equal(result.items.length, 2);
});

test('keeps a legitimate single requirement that explicitly states a cue', () => {
  // #125: one line is usually a stray sentence — unless it is an explicitly
  // stated requirement ("University degree in…", "3+ years with…").
  const single = [
    'We are hiring a data analyst.',
    'Requirements',
    'University degree in a numerate subject with three years of experience with SQL.',
    'What we offer',
    'A competitive salary.',
  ].join('\n');
  const result = extractRequirements(single);
  assert.ok(result, 'a single explicitly stated requirement must be kept');
  assert.equal(result.items.length, 1);
  assert.match(result.items[0], /University degree/i);
});

test('extracts clearly stated requirements without any heading', () => {
  // #125: no recognised heading, but two sentences explicitly state what the
  // candidate must bring. Returned with an empty heading so the card labels
  // them as extracted from the available text, never as a quoted section.
  const ad3 = [
    'We are a mid-sized logistics company with customers across Europe.',
    '',
    'You have three years of experience with SQL and a degree in a numerate subject.',
    'Experience with Power BI is a strong advantage for this role.',
    '',
    'You will own the reporting estate and work closely with finance.',
  ].join('\n');
  const result = extractRequirements(ad3);
  assert.ok(result, 'clearly stated requirements without a heading must be extracted');
  assert.equal(result.heading, '');
  assert.ok(result.items.length >= 2);
  assert.ok(!result.items.some((item) => /mid-sized logistics/i.test(item)), 'company blurb stays out');
  assert.ok(!result.items.some((item) => /own the reporting estate/i.test(item)), 'responsibilities stay out');
});

test('never extracts Job-Room metadata, benefits or responsibilities as requirements', () => {
  // #125 negative fixtures: the unheaded-bullet fallback was rejected for
  // ingesting source metadata and stays removed. Benefits and duties carry no
  // requirement cue and must stay out too.
  const meta = [
    'We are hiring a data analyst.',
    '• **Seniority Level**',
    '• **Jobtyp**',
    '• Temporär',
  ].join('\n');
  assert.equal(extractRequirements(meta), null, 'source metadata must never read as requirements');
  const benefits = [
    'We are hiring a data analyst.',
    '',
    'We offer a competitive salary and twenty-six days of holiday.',
    'About us: we are a friendly company with a nice office.',
  ].join('\n');
  assert.equal(extractRequirements(benefits), null, 'benefits and company blurb stay out');
  const duties = [
    'We are hiring a data analyst.',
    '',
    'You will own the reporting estate for our operations team.',
    'You will run the weekly reporting cycle and keep dashboards honest.',
  ].join('\n');
  assert.equal(extractRequirements(duties), null, 'duties without a requirement cue stay out');
});

test('preserves optional wording and negations verbatim', () => {
  // #125: modality is part of the answer. "A plus" and "No … required" must be
  // quoted as written, not normalised away.
  const ad4 = [
    'Requirements',
    '• Three years of experience with SQL; Power BI is a strong plus.',
    '• No German is required for this English-speaking team.',
  ].join('\n');
  const result = extractRequirements(ad4);
  assert.ok(result);
  assert.ok(result.items.some((item) => /plus/i.test(item)), 'preferred wording is kept');
  assert.ok(result.items.some((item) => /No German is required/i.test(item)), 'negation is kept verbatim');
});

test('handles long conditions and cutoff text without inventing', () => {
  // A legitimate long condition (under 300 chars) is kept; an empty ad and a
  // truncated preview with nothing quotable return null rather than a guess.
  const longItem = `You have ${'very specific experience with enterprise data governance and SAP master data '.repeat(3).trim()}.`;
  assert.ok(longItem.length < 300, 'fixture must stay within the quotable cap');
  const ad5 = ['Requirements', `• ${longItem}`, '• A degree in information management.'].join('\n');
  const longResult = extractRequirements(ad5);
  assert.ok(longResult);
  assert.equal(longResult.items.length, 2);
  assert.equal(extractRequirements(''), null);
  assert.equal(extractRequirements('A great role. Apply today…'), null, 'a cutoff preview with no cue stays null');
});

test('preserves heading modality in the rail label (#125 fix)', () => {
  // PR #128 review: `Nice to have\nExperience with Python\nExperience with SQL`
  // extracts heading "Nice to have" with two items, but the card rendered only
  // "Asks for" and silently promoted nice-to-haves to must-haves.
  const result = extractRequirements('Nice to have\nExperience with Python\nExperience with SQL');
  assert.ok(result, 'the optional heading must still extract');
  assert.equal(result.heading, 'Nice to have');
  assert.equal(result.items.length, 2);
  assert.equal(formatRequirementsRailLabel(result.heading), 'Asks for — Nice to have');
  // A mandatory heading is preserved the same way, never normalised away.
  assert.equal(formatRequirementsRailLabel('Must have'), 'Asks for — Must have');
  // Unheaded extractions keep the bare rail; whitespace-only headings do too.
  assert.equal(formatRequirementsRailLabel(''), 'Asks for');
  assert.equal(formatRequirementsRailLabel('   '), 'Asks for');
});
