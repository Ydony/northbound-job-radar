import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { parseCapacityArgs, runCapacityProbe } from '../scripts/measure-vps-capacity.mjs';

test('capacity options reject an unbounded or remote probe without explicit owner acknowledgment', () => {
  assert.throws(() => parseCapacityArgs(['--base', 'https://example.com']), /owner-host/);
  assert.throws(() => parseCapacityArgs(['--base', 'http://127.0.0.1:3210', '--requests', '51']), /requests/);
  assert.throws(() => parseCapacityArgs(['--base', 'http://127.0.0.1:3210', '--parallel', '6']), /parallel/);
});

test('capacity probe makes only bounded authenticated GETs and reports successful latency', async () => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method, path: request.url, cookie: request.headers.cookie });
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json');
    response.end('{"account":{"id":"synthetic"},"jobs":[]}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const result = await runCapacityProbe({ base, cookie: 'session=synthetic', requests: 5, parallel: 2 });
    assert.equal(seen.length, 5);
    assert.ok(seen.every((entry) => entry.method === 'GET' && entry.path === '/api/state' && entry.cookie === 'session=synthetic'));
    assert.equal(result.requests, 5);
    assert.equal(result.attempted, 5);
    assert.equal(result.ok, 5);
    assert.equal(result.failures, 0);
    assert.ok(result.latencyMs.p95 >= result.latencyMs.p50);
  } finally {
    server.close();
  }
});

test('capacity probe refuses a 200 login page instead of counting it as dashboard success', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader('Content-Type', 'text/html');
    response.end('<html>Sign in</html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runCapacityProbe({
      base: `http://127.0.0.1:${server.address().port}`, cookie: 'session=synthetic', requests: 3, parallel: 1,
    });
    assert.equal(requests, 1);
    assert.equal(result.failures, 1);
    assert.equal(result.attempted, 1);
  } finally {
    server.close();
  }
});

test('capacity probe stops scheduling after the first failed response', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.statusCode = 503;
    response.end('down');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runCapacityProbe({
      base: `http://127.0.0.1:${server.address().port}`, cookie: 'session=synthetic', requests: 5, parallel: 1,
    });
    assert.equal(requests, 1);
    assert.equal(result.attempted, 1);
    assert.equal(result.failures, 1);
    assert.equal(result.statuses['503'], 1);
  } finally {
    server.close();
  }
});

test('parallel probe stops on failed headers even when the error body is slow', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    if (requests === 1) {
      response.statusCode = 503;
      response.flushHeaders();
      setTimeout(() => response.end('down'), 200);
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"account":{"id":"synthetic"},"jobs":[]}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runCapacityProbe({
      base: `http://127.0.0.1:${server.address().port}`, cookie: 'session=synthetic', requests: 20, parallel: 5,
    });
    assert.ok(requests <= 5, `only the initial in-flight requests may have started; got ${requests}`);
    assert.ok(result.attempted <= 5);
    assert.ok(result.failures >= 1);
  } finally {
    server.close();
  }
});

test('cancelled siblings are reported separately from the one real failure', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    if (requests === 1) {
      setTimeout(() => {
        response.statusCode = 429;
        response.end('rate limited');
      }, 30);
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.flushHeaders();
      setTimeout(() => response.end('{"account":{"id":"synthetic"},"jobs":[]}'), 250);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runCapacityProbe({
      base: `http://127.0.0.1:${server.address().port}`, cookie: 'session=synthetic', requests: 20, parallel: 5,
    });
    assert.equal(result.failures, 1);
    assert.equal(result.statuses['429'], 1);
    assert.equal(result.statuses.network ?? 0, 0);
    assert.ok(result.aborted >= 1);
    assert.equal(result.attempted, result.aborted + result.failures);
    assert.equal(result.ok, 0);
  } finally {
    server.close();
  }
});

test('capacity probe refuses redirects rather than following them to another endpoint', async () => {
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    if (request.url === '/api/state') {
      response.statusCode = 302;
      response.setHeader('Location', '/api/scrape');
    }
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runCapacityProbe({
      base: `http://127.0.0.1:${server.address().port}`, cookie: 'session=synthetic', requests: 2, parallel: 1,
    });
    assert.deepEqual(paths, ['/api/state']);
    assert.equal(result.failures, 1);
    assert.equal(result.attempted, 1);
  } finally {
    server.close();
  }
});
