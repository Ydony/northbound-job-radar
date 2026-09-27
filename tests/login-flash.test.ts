import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import JobRadar from '../app/job-radar';

test('initial dashboard HTML contains only a session placeholder, never workspace controls', () => {
  const html = renderToStaticMarkup(createElement(JobRadar));
  assert.match(html, /Checking your session/);
  assert.match(html, /role="status"/);
  for (const text of ['Screened jobs', 'Find new jobs', 'Sign out', 'Search settings', 'Statistics']) {
    assert.ok(!html.includes(text), `dashboard flashed ${text} before authentication`);
  }
  assert.ok(!html.includes('<nav'));
});
