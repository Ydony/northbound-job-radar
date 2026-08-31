# Optional external VPN setup

Ik ben een appel can run locally while Windows sends its network traffic through an external
VPN. This is an optional privacy layer, not permission to automate a website and not an
anonymity guarantee.

## Recommended free setup

Windscribe Free is the default because its free Windows plan includes Netherlands and
Switzerland locations. Proton VPN Free is supported as an alternative and offers unlimited
data, but its free plan may choose the exit country automatically.

From the repository directory, run:

```text
npm run vpn:setup
```

This installs the official Windscribe package through Windows Package Manager and opens
the application. Account creation, sign-in, Netherlands selection, Firewall/Kill Switch,
and split-tunnel settings require one visible setup because the providers do not publish a
supported Windows automation interface for those account and security settings. Ik ben een appel
does not request or store VPN credentials.

To install Proton VPN instead:

```text
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-vpn.ps1 -Provider ProtonVPN
```

## Start with VPN enforcement

After the one-time provider setup, use:

```text
npm run dev:private
```

The launcher starts an installed VPN client when necessary, waits briefly for auto-connect,
and refuses to start Ik ben een appel unless it detects a supported active adapter with a full
IPv4 tunnel route. It then shows the exit IP and country using Cloudflare's trace endpoint.

Run only the check with:

```text
npm run vpn:check
```

The check intentionally fails when it sees split tunneling without a full IPv4 route. VPN
browser extensions do not protect Ik ben een appel' server-side requests and are not accepted by
the launcher.

## Boundaries

- Do not commit VPN configuration files, WireGuard private keys, usernames, or passwords.
- Do not use free public HTTP/SOCKS proxies; their operators can observe or modify traffic.
- Do not add proxy rotation, IP cycling, fingerprint spoofing, or bot-detection evasion.
- A VPN changes the visible source IP. It does not override a job site's terms or authorize
  scraping, automated login, or application submission.

## Apple / macOS

The same enforced workflow is available on macOS. It installs the official Windscribe
application through Homebrew, opens it for the one-time sign-in and macOS VPN permission,
then checks for a full route over an active `utun` interface.

```text
npm run vpn:setup:mac
npm run vpn:check:mac
npm run dev:private:mac
```

The private launchers default to dev. Use the corresponding `test:private` command when the stable
test environment needs the same VPN guard.

Homebrew must already be installed; if it is missing, the setup script opens the official
Homebrew page and stops instead of downloading and executing an unreviewed bootstrap script.
To use Proton VPN instead, run `bash scripts/setup-vpn-macos.sh ProtonVPN`.

Use Windscribe Firewall mode **Always on** and disable split tunnelling. On an Intel Mac
with Apple's T2 security chip, review the provider's current kill-switch guidance before
using Proton VPN because that combination has a documented macOS stability limitation.
