# Host checks — authorized private access only (T37 / F12)

These checks run **on the VPS over an authorized private session** (owner or
explicitly delegated operator). They are documented here, not executed here:
Spark packets have no host access, and `scripts/verify-deploy-hardening.mjs`
covers only what is statically verifiable in the worktree. Record the outcome
(date, host, result) against the release issue; any failure blocks release.

## 1. Unit sandbox is actually applied

```bash
systemctl cat ikbeneenappel-web.service ikbeneenappel-refresh.service ikbeneenappel-litestream.service
systemd-analyze security ikbeneenappel-web.service ikbeneenappel-litestream.service
# Expected: no `User=root`, overall exposure rating "safe" or "medium" with
# only the documented V8-JIT exceptions (MemoryDenyWriteExecute, PrivateUsers).
systemctl show ikbeneenappel-web.service -p User,NoNewPrivileges,ProtectSystem,PrivateTmp
ps -o user,comm -C node  # must show ikbeneenappel, never root
```

## 2. Network surface: ports, SSH, proxy

```bash
ss -tlnp  # Expected: 443 (nginx) + loopback 3000 only. Nothing else listens publicly.
sudo ufw status verbose  # Expected: deny incoming default; allow 443/tcp, 80/tcp (certbot), SSH only from the owner's address
sudo sshd -T | grep -iE 'permitroot|passwordauth|permit.*password|challenge'
# Expected: PermitRootLogin no (or prohibit-password), PasswordAuthentication no
curl -sI https://ikbeneenappel.nl/ | grep -iE 'strict-transport|x-frame|x-content|referrer-policy'
nginx -t && systemctl reload nginx
# Negative probes — all must return 404, never file content:
for p in /app.sqlite /.git/HEAD /.env /.local/x /dist/standalone/server.js /local-backups/x /backup.sql; do
  curl -s -o /dev/null -w "%{http_code} $p\n" "https://ikbeneenappel.nl$p";
done
```

## 3. Updates and certificates

```bash
systemctl status unattended-upgrades.timer  # Expected: active, waiting
apt list --upgradable 2>/dev/null | head  # record pending security updates and their disposition
certbot certificates  # Expected: valid, auto-renew timer active
node --version  # must satisfy engines.node >= 22.13.0
```

## 4. Secrets and file permissions (names only — never print values)

```bash
stat -c '%a %U %n' /etc/ikbeneenappel/env /etc/ikbeneenappel/litestream.yml
# Expected: 600 root on both
sudo -u ikbeneenappel env | grep -cE 'SECRET|KEY' || true  # process env must not leak via logs
```

## 5. Backup replication and restore (VPS-07 procedure, see docs/DEPLOY.md)

Replication is verified by inspecting the remote bucket (snapshots/WAL
minutes old), then running the full scratch-path restore drill from
docs/DEPLOY.md §"Restore procedure". The drill — version match,
`integrity_check = ok`, per-table counts, scratch-instance dashboard load —
is the evidence; the unit being green is not.

## 6. Dependency / artifact / secret scans (CI gate)

- `node scripts/verify-deploy-hardening.mjs --audit` — template directives,
  tracked-file hygiene, secret-pattern scan, plus `npm audit --omit=dev
  --audit-level=high`. Fails the release on any High/Critical finding.
- `npm test -- tests/deploy-hardening.test.ts` — regression pins for the
  sandbox directives and proxy brake.
- Remaining findings get an explicit disposition in the release issue; silent
  tolerance is not a disposition.

## What was actually run in the Spark packet (no host access)

- `node scripts/verify-deploy-hardening.mjs` (without `--audit`; registry
  unreachable from the sandbox — recorded below) — plus `npm audit` attempted
  separately where noted.
- `npm test -- tests/deploy-hardening.test.ts`, `npm run lint` (scoped),
  `npm run typecheck`.
- Result and commit recorded in the task output; host sections above remain
  open until run on the VPS.
