import assert from 'node:assert/strict';
import test from 'node:test';
import { extractRequirements } from '../lib/requirements';

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
