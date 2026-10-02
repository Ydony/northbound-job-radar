# VPS host checks — owner-run, on the machine, over authorized private access

T37 evidence companion. `npm run verify:deploy-hardening` proves the
**templates** are hardened, untracked artefacts stay untracked, and production
dependencies are clean — all from the repo, with synthetic fixtures only. It
cannot prove the host actually runs those templates. **Nothing below runs from
a Spark packet, CI, or any remote session**: every command here executes on
the VPS itself, by the owner (or someone the owner explicitly authorized),
over private access. Restored data holds real account rows, so nothing from
these checks — outputs, paths, addresses, secret names beyond what is already
in `docs/DEPLOY.md` — goes into the repo, an issue, or a transcript. Record
pass/fail and the date on the tracking task, not the output.

Run top to bottom after first install, after every template change, and before
cutover (#201). Any failure blocks release until it is fixed or re-scoped by
the owner.

## 0. What the repo already proved (2026-10-02, worktree)

- `verify:deploy-hardening` PASS: three systemd units pin
  `User=ikbeneenappel` + `NoNewPrivileges` + the full containment set
  (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`,
  kernel-module/tunable/control-group guards, `RestrictSUIDSGID`,
  `RestrictRealtime`); nginx terminates TLS 1.2+, hides its version, caps
  bodies at 1 MB, rate-limits auth, upstreams loopback only, and 404s
  dotfiles, SQLite files, env/vars files, backups and VCS metadata.
- `git ls-files`: no `*.sqlite`/`*.db`/`.dev.vars.*`/`.env`/backup/key file
  tracked; secret-pattern scan clean; `.dev.vars.example` holds placeholders.
- `npm audit --omit=dev`: **zero** Critical/High advisories in production
  dependencies. Full `npm audit` (dev included): 13 High + 1 Low, all inside
  the local build toolchain (`wrangler`/`vite`/`miniflare` chain — never
  shipped in `dist/standalone`), except one shipped-bundle finding kept open
  below.

## 1. Units actually installed and contained

```bash
systemctl is-enabled ikbeneenappel-web.service ikbeneenappel-litestream.service ikbeneenappel-refresh.timer
systemctl is-active ikbeneenappel-web.service ikbeneenappel-litestream.service ikbeneenappel-refresh.timer
# expected: enabled, enabled, enabled / active, active, active
systemctl show -p User,NoNewPrivileges,ProtectSystem,ProtectHome,PrivateTmp ikbeneenappel-web.service
# expected: User=ikbeneenappel, NoNewPrivileges=yes, ProtectSystem=strict, ProtectHome=yes, PrivateTmp=yes
# (repeat for the litestream unit; the refresh unit is oneshot — check the timer owns its cadence)
systemd-analyze security ikbeneenappel-web.service ikbeneenappel-litestream.service
# expected: overall exposure "safe" or a short list you can explain line by
# line. UNSAFE verbs on MemoryDenyWriteExecute/SystemCallFilter are the two
# reviewed omissions (Node JIT; per-build syscall surface) — anything else
# new is a finding, not background noise.
ps -o user= -C node | sort -u
# expected: only ikbeneenappel (nothing runs as root)
```

## 2. Ports, SSH and updates

```bash
ss -tlnp
# expected: :80 and :443 owned by nginx; :22 by sshd; NOTHING public on :3000
# (the app listens on 127.0.0.1 only — a public :3000 bypasses every nginx
# brake in deploy/nginx-ikbeneenappel.conf)
sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin|allowusers|pubkeyauthentication)'
# expected: passwordauthentication no, permitrootlogin no (or prohibit-password),
# pubkeyauthentication yes, allowusers limited to the owner's account
ufw status verbose || nft list ruleset
# expected: default deny incoming; only 22 (restricted source if the owner set
# one), 80, 443 open
systemctl is-active unattended-upgrades.service || systemctl status unattended-upgrades --no-pager
apt-config dump APT::Periodic 2>/dev/null
# expected: automatic security updates on, with a recent /var/log/unattended-upgrades/ run
```

## 3. Secrets, files and the database

```bash
ls -l /etc/ikbeneenappel/env /etc/ikbeneenappel/litestream.yml
# expected: root-owned, 0600/600 — group and other read bits clear
namei -l /var/lib/ikbeneenappel/app.sqlite 2>/dev/null || ls -ld /var/lib/ikbeneenappel
# expected: owned by ikbeneenappel, no wider than 0700 on the directory
sudo -u ikbeneenappel sqlite3 "$SQLITE_PATH" "PRAGMA integrity_check;"
# expected: one line reading ok
curl -s -o /dev/null -w '%{http_code}\n' https://ikbeneenappel.nl/.git/HEAD \
  https://ikbeneenappel.nl/app.sqlite https://ikbeneenappel.nl/.dev.vars.dev \
  https://ikbeneenappel.nl/local-backups/
# expected: 404 four times (the deny blocks answer 404 so a prober learns
# nothing about what exists)
```

## 4. Proxy and TLS from the outside

```bash
nginx -t
# expected: syntax ok, test is successful
curl -sSI https://ikbeneenappel.nl/ | grep -Ei '^(HTTP|strict-transport|x-frame|x-content|content-security|server:)'
# expected: HTTP/2 200, HSTS present, X-Frame-Options DENY, a nonce CSP, and
# NO Server: version banner
curl -s -o /dev/null -w '%{http_code}\n' http://ikbeneenappel.nl/
# expected: 301 to https
openssl s_client -connect ikbeneenappel.nl:443 -tls1_1 -brief </dev/null 2>&1 | head -3
# expected: handshake failure (TLS 1.0/1.1 refused)
```

## 5. Backups actually replicate (owner-run, before cutover)

The synthetic rehearsal (`verify:sqlite-restore`) proves the procedure's
logic, not the VPS's replication. The real drill is `docs/DEPLOY.md` §
"Restore procedure": stop both units, `litestream restore` into a scratch
path, compare `schema_migrations` version + per-table counts against the live
file, serve one real dashboard from the scratch copy on a throwaway port,
delete the scratch copy, restart. Record version, counts and the dashboard
load on #200. A drill that never ran is not a backup.

## 6. Remaining findings and dispositions

| Finding | Disposition |
|---|---|
| `react-server-dom-webpack@19.2.6` High (Server-Functions DoS, fixed in 19.3.0). It ships inside the standalone bundle even though it is classified dev-only, so `npm audit --omit=dev` does not surface it. | **Open, separately scoped.** Reachability through this app's RSC usage is unassessed; upgrade to ≥19.3.0 with the full gate (tests, build, `verify:selfhosted`) as its own task. Blocks public launch, not the private single-admin deployment. |
| 12 remaining High + 1 Low, all in the `wrangler`/`vite`/`miniflare` local toolchain. | **Accepted for local use.** They run on the owner's machine during builds, never in the served bundle or on the host. Re-check on every dependency change; any advisory moving into the production path reopens this row. |
| Administrator MFA. | **Recommended separate decision** during threat review (per F12 scope), not implemented or claimed here. |
| Host checks in §§1–5 above. | **Must be owner-run before cutover (#201).** This repo cannot perform them; an unchecked box blocks release. |
