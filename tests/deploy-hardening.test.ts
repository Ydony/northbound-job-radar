import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

/**
 * T37: the service/proxy templates stay hardened. The same assertions run in
 * `npm run verify:deploy-hardening` alongside the git/network checks that do
 * not belong in a unit test; these pin the template contents so an edit that
 * drops a directive fails `npm test`, not just the verifier.
 *
 * Two directives are pinned ABSENT, not present: MemoryDenyWriteExecute
 * breaks Node's JIT and SystemCallFilter turns every Node upgrade into a
 * potential outage. The absence is the reviewed decision — see the comments
 * in deploy/ikbeneenappel-web.service — so assert it rather than leaving it
 * to drift back in.
 */
const root = join(import.meta.dirname, '..');
function read(name: string): string {
  return readFileSync(join(root, name), 'utf8');
}

const units = [
  'deploy/ikbeneenappel-web.service',
  'deploy/ikbeneenappel-refresh.service',
  'deploy/ikbeneenappel-litestream.service',
];
const requiredDirectives = [
  'User=ikbeneenappel',
  'NoNewPrivileges=true',
  'ProtectSystem=strict',
  'ProtectHome=true',
  'PrivateTmp=true',
  'PrivateDevices=true',
  'ProtectKernelTunables=true',
  'ProtectKernelModules=true',
  'ProtectControlGroups=true',
  'RestrictSUIDSGID=true',
  'RestrictRealtime=true',
  'ReadWritePaths=/var/lib/ikbeneenappel',
];

for (const unit of units) {
  test(`${unit} runs unprivileged and contained`, () => {
    const body = read(unit);
    assert.doesNotMatch(body, /^User=root/m, 'never runs as root');
    for (const directive of requiredDirectives) {
      assert.ok(body.includes(directive), `${unit} is missing ${directive}`);
    }
  });

  test(`${unit} documents its deliberate omissions`, () => {
    const body = read(unit);
    // Directive lines only: the comments name these settings to explain why
    // they are absent, so a plain substring check would fail on the comment.
    assert.doesNotMatch(body, /^MemoryDenyWriteExecute=/m,
      'MemoryDenyWriteExecute would crash Node on start');
    assert.doesNotMatch(body, /^SystemCallFilter=/m,
      'a SystemCallFilter would couple the unit to one Node build');
  });
}

test('the collector stays a oneshot unit behind a timer', () => {
  assert.ok(read('deploy/ikbeneenappel-refresh.service').includes('Type=oneshot'));
  assert.ok(read('deploy/ikbeneenappel-refresh.timer').includes('OnCalendar='));
});

test('nginx terminates TLS, brakes floods and hides artefacts', () => {
  const nginx = read('deploy/nginx-ikbeneenappel.conf');
  assert.ok(nginx.includes('server_tokens off;'));
  assert.match(nginx, /ssl_protocols\s+TLSv1\.2\s+TLSv1\.3;/);
  assert.ok(nginx.includes('ssl_session_tickets off;'));
  assert.match(nginx, /listen 80;[\s\S]*return 301 https:/);
  assert.ok(nginx.includes('client_max_body_size 1m;'));
  assert.ok(nginx.includes('limit_req zone=auth'));
  const upstreams = [...nginx.matchAll(/server\s+([^;]+);/g)]
    .map((m) => m[1].trim())
    .filter((s) => /^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(s));
  assert.ok(upstreams.length > 0, 'an IP upstream exists to check');
  for (const upstream of upstreams) {
    assert.ok(upstream.startsWith('127.0.0.1'), `non-loopback upstream: ${upstream}`);
  }
  for (const marker of ['sqlite', 'local-backups', '.wrangler', 'pem']) {
    assert.ok(nginx.includes(marker), `no deny block for ${marker}`);
  }
  // .dev.vars/.env/.git carry no literal marker: the dotfile block covers
  // them, which is what this asserts.
  assert.match(nginx, /location ~ \/\\\.\s*\{\s*\n(\s.*\n)*?\s*return 404;/m,
    'no dotfile deny block (.dev.vars, .env, .git)');
  // The app owns the nonce CSP and framing headers; a proxy copy would be
  // enforced in addition and silently break hydration or framing.
  assert.doesNotMatch(nginx, /add_header\s+Content-Security-Policy/i);
  assert.doesNotMatch(nginx, /add_header\s+X-Frame-Options/i);
});

test('.gitignore covers secrets and database artefacts', () => {
  const gitignore = read('.gitignore');
  for (const pattern of ['.dev.vars', '.env', '*.sqlite', '*.db', '*.pem', '*.key', '.wrangler', '.local', '/dist/']) {
    assert.ok(gitignore.includes(pattern), `.gitignore is missing ${pattern}`);
  }
});
