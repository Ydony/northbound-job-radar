# Actual-phone owner checklist (F6 / T21)

Only the owner can do this pass: it runs on the owner's real phone, against the live
private production site, with no PC involved at any step. Assistants must never perform
it — no production credentials, systems, or data belong in a work packet.

## What synthetic evidence already proves (no phone needed)

| Claim | Evidence | Command |
|---|---|---|
| Dashboard usable at 390px: no sideways scroll, nothing overflowing, every control clears the 44px tap floor, no text below 12px, type on the ladder | `scripts/check-visual.mjs` phone pass (dashboard only) | `npm run dev` in one terminal, then `npm run check:visual` on a machine with Chrome/Edge |
| Signup, settings and source status work end to end when requested with a phone user agent: registration + email verification, weak/wrong-password refusals, email/password change with stale-session revocation, ordinary `/sources` omits `Restricted sites`, administrator `/sources` shows it | `scripts/verify-phone-workflow.mjs` (T21; HTTP-level, runs anywhere) | `npm run dev` in one terminal, then `npm run verify:phone` |
| Administrator/ordinary source split in the serving path, not just the page | `tests/source-access.test.ts`, `tests/public-admin-isolation.test.ts`, `tests/source-policies.test.ts` | `npm test` |

What those cannot prove: how the pages feel under a thumb, whether anything is
unreachable behind a hover-only or desktop-width interaction, and whether a search
survives backgrounding the phone browser. That is this checklist.

## Setup

- Phone only from here on. If any step needs the PC, stop and record it — that is a finding.
- Use the live private production Worker over mobile data first, then repeat the search step on Wi-Fi.
- Sign in as the administrator first; repeat the marked steps as an ordinary account if one exists.

## The pass

### Signup and sign-in (skip if registration is closed in production)

- [ ] Open the site fresh (no saved tab). The sign-in screen is readable without zooming or sideways scrolling.
- [ ] Switch to registration. The 12-character hint, the bot check, and the privacy-consent checkbox are all reachable and tappable.
- [ ] Registering with a short password is refused with a readable message.
- [ ] The verification link from the email app signs the phone session in.

### Search setup and collection

- [ ] Set roles, countries, and required/excluded words from Search settings without an inaccessible control.
- [ ] Trigger a search and read progress and per-source results on the phone.
- [ ] Background the browser mid-collection (switch apps, lock the phone), then return: the run report and results are intact, with no need to redo anything from a PC.

### Results on the phone

- [ ] Open a language explanation, correct a result, and save / dismiss / mark applied.
- [ ] Filter, page through results ("Show more jobs"), leave and return without lost state.
- [ ] Every source and application link opens its advertisement; nothing requires hovering.

### Settings

- [ ] Change email and password from Settings on the phone; the session refreshes and the old session is dead.
- [ ] Ordinary account: Settings shows only the account controls; `/sources` shows only the public groups.

### Administrator source status

- [ ] `/sources` shows the extra-source status (including the Restricted-sites section) and it matches what the PC shows.
- [ ] The System manager page loads its counts; account actions are usable if you need them.

## Recording

For each box: device, OS/browser, date, pass/fail, and what exactly was wrong (screenshot
helps). Failures go back to the F6 child tasks on the project board with the phone model
and the narrowest failing width. When every box passes on the owner's phone with no PC
step anywhere, F6's last acceptance criterion is met.
