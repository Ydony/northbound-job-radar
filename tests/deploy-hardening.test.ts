import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const units = [
  'deploy/ikbeneenappel-web.service',
  'deploy/ikbeneenappel-refresh.service',
  'deploy/ikbeneenappel-litestream.service',
];

// T37: the 2026-09-29 review found units running as User=ikbeneenappel with
// NoNewPrivileges=true but without any filesystem/kernel sandboxing. These
// tests pin the sandbox so a template edit cannot silently drop it.
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
  'LockPersonality=true',
  'RestrictRealtime=true',
  'RemoveIPC=true',
  'ProtectClock=true',
  'ProtectHostname=true',
  'ReadWritePaths=/var/lib/ikbeneenappel',
  'UMask=0027',
];

for (const unit of units) {
  test(`${unit} runs unprivileged inside the filesystem sandbox`, () => {
    const body = read(unit);
    for (const directive of requiredDirectives) {
      assert.ok(body.includes(directive), `${unit} is missing ${directive}`);
    }
    assert.ok(!/^User=root/m.test(body), `${unit} must not run as root`);
  });
}

test('refresh timer keeps the 6-hour cadence with no backlog burst', () => {
  const body = read('deploy/ikbeneenappel-refresh.timer');
  assert.ok(body.includes('OnCalendar=*-*-* 00,06,12,18:00'), 'expected the 6-hour cadence');
  assert.ok(body.includes('Persistent=true'), 'expected Persistent=true so downtime replays at most one tick');
});

test('nginx template brakes auth floods and hides file paths', () => {
  const body = read('deploy/nginx-ikbeneenappel.conf');
  for (const needle of [
    'limit_req_zone',
    'limit_req zone=auth',
    'limit_req_status 503',
    'client_max_body_size',
    'return 404;',
  ]) {
    assert.ok(body.includes(needle), `nginx conf is missing ${needle}`);
  }
  assert.ok(!/add_header\s+(Strict-Transport-Security|Content-Security-Policy|X-Frame-Options)/.test(body),
    'security headers come from the app; the proxy must not double-send them');
});
