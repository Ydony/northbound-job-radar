# Install and use Ik ben een appel

Ik ben een appel is a private, local job-screening application. It stores CV files and analyzed jobs in
one of two isolated local environments. Do not deploy it without a new explicit owner decision.

## Give the repository to Codex

Copy this repository URL:

```text
https://github.com/Ydony/northbound-job-radar
```

Suggested prompt for Codex on a new computer:

```text
Clone https://github.com/Ydony/northbound-job-radar, read AGENTS.md, README.md,
docs/GETTING_STARTED.md, and docs/VPN.md completely, then install and run Ik ben een appel
locally. Do not deploy it publicly. I use macOS; identify whether this Mac is Apple
Silicon or Intel, install the appropriate prerequisites, help me complete the visible
Windscribe setup without reading or storing my credentials, verify the VPN, and start
the app with npm run dev:private:mac.
```

Codex should preserve the visible VPN sign-in boundary. Never paste a Windscribe account
hash, VPN password, WireGuard private key, CV, or `.wrangler/` directory into a prompt or
commit.

## Apple / macOS installation

The application and Windscribe support both Apple Silicon (M-series) and Intel Macs. The
setup script uses Homebrew, which selects the correct package architecture automatically.
For a currently supported Homebrew installation, use macOS 14 Sonoma or newer.

1. Open Terminal.
2. Run `uname -m`. `arm64` means Apple Silicon; `x86_64` means Intel. This is only a
   confirmation step—the commands below work for both.
3. If Git developer tools are missing, run `xcode-select --install` and finish Apple's
   installer.
4. Install Homebrew from [brew.sh](https://brew.sh/) if it is not already installed. On
   Apple Silicon it normally lives under `/opt/homebrew`; on Intel it normally lives under
   `/usr/local`. Follow the `shellenv` instruction printed by Homebrew if `brew` is not
   found after installation.
5. Install Node.js 24 and Git:

   ```text
   brew install node@24 git
   ```

   Homebrew marks versioned Node packages as keg-only. Follow the `brew info node@24`
   instruction to add it to the shell path, then confirm `node --version` reports 24.x and
   both `npm --version` and `git --version` work.
6. Clone and install Ik ben een appel:

   ```text
   git clone https://github.com/Ydony/northbound-job-radar.git
   cd northbound-job-radar
   npm install
   ```

   Create the two independent local session-secret files:

   ```text
   npm run init-secrets
   ```

7. Install and open the free Windscribe application:

   ```text
   npm run vpn:setup:mac
   ```

8. Create a separate Windscribe account for this user. If using anonymous/hashed signup,
   save the newly generated hash in a password manager; it cannot be recovered. Never share
   another person's hash.
9. In Windscribe, select **Netherlands**, set **Firewall Mode** to **Always on**, disable
   **Split tunnelling**, and enable automatic connection. Allow the macOS VPN configuration
   when prompted.
10. Verify the full tunnel:

   ```text
   npm run vpn:check:mac
   ```

   The result must show a VPN route and an external country. If it fails, reconnect
   Windscribe and confirm split tunnelling is disabled.
11. Start Ik ben een appel through the enforced launcher:

    ```text
    npm run dev:private:mac
    ```

12. Open `http://localhost:3000`. The port is fixed so another process cannot silently become the
    environment you use.

The macOS launcher checks for a full IPv4 route through an active `utun` interface. A
browser-only VPN extension is insufficient because it does not protect server-side job
requests made by the local application.

Official references: [Homebrew installation](https://docs.brew.sh/Installation),
[Homebrew Node.js 24 formula](https://formulae.brew.sh/formula/node@24), and
[Windscribe macOS setup](https://windscribe.com/knowledge-base/articles/getting-started-with-windscribe-on-macos).

## Windows installation

Requirements are Windows 10/11, Node.js 22.13 or newer, Git, and Windows Package Manager
(`winget`). After cloning the repository and running `npm install`:

```text
npm run vpn:setup
npm run vpn:check
npm run dev:private
```

The setup command installs the official Windscribe package. Complete account creation and
sign-in visibly, select Netherlands, enable Firewall, disable split tunnelling, and leave
auto-connect enabled. Ik ben een appel never reads or stores the VPN credentials.

## Using Ik ben een appel

1. Upload one or two text-based PDF, DOCX, or TXT CVs. Scanned image-only PDFs need OCR and
   are not supported yet.
2. Review the detected role for each CV and use the role-override fields when necessary.
3. Add up to five role keywords, then set optional location, workplace, seniority,
   contract, required keywords, and excluded keywords. Save the criteria.
4. With a full VPN route active, choose **Search all job sites**. The source report says
   exactly which Swiss and Netherlands adapters completed, failed, or were blocked.
5. Use country, Applied/Not applied, source, and result filters on the unified job list.
   **Analyze a job** remains available for a public HTTPS ad that could not be fetched.
6. Read the language result:
   - **English sufficient** means the full ad appears English and no local language was
     detected as mandatory.
   - **Needs review** means the evidence is ambiguous. Review it manually.
   - **Local language required** means German, French, Italian, or Dutch appears mandatory,
     or the advertisement is not predominantly English.
7. Mark language decisions accurate or correct them with a reason. Save jobs, mark them
   Applied or Not applied, and dismiss/restore unsuitable roles. Dismissed adverts are
   suppressed during future searches.
8. Open the original source to apply personally. Ik ben een appel does not log in or submit an
   application for the user.
9. Use JSON/CSV export and deletion controls to manage local data.

## Important source warning

**Search all job sites** performs manually triggered, capped public-page fetches. The three
JobCloud adapters (jobs.ch, jobup.ch, and JobScout24) are contrary to JobCloud's published
automation terms and are not sanctioned integrations. Indeed remains blocked. IamExpat
and Undutchables use current public paths, but source policies and markup can change. A new
user should read `docs/ARCHITECTURE.md` §2 and disable adapters they do not accept; manual
**Analyze a job** remains the fallback. No source login or application is automated.

## Local data and troubleshooting

- Dev data lives under `.wrangler/dev/state`; stable test data lives under
  `.wrangler/test/state`. Never copy one over the other while either server is running.
- Use `npm run dev` for hot-reload development on port 3000. Use `npm run test:local` to build and
  run the stable local test Worker on port 3001.
- Never share or commit `.wrangler/`, `.env`, `tmp/`, `work/`, VPN configurations, or CVs.
- Only one `vinext dev` server can run on a computer. Stop the existing server before
  starting another checkout.
- Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` after changes.
- See `docs/VPN.md` for provider alternatives and detailed VPN boundaries.
