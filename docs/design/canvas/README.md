# The reviewed design

The agreed design for every screen, as signed off with the owner on 2026-09-21. Thirteen
frames, saved here because the canvas they came from is a private artifact that nobody else
can open and that nothing in this repository can point at.

Open **`index.html`** in a browser. Every frame renders standalone — they are plain HTML with
inline styles and two Google fonts, no build step and no server.

| Frame | What it settles |
|---|---|
| `Main.html` | the page **as it was**, carrying the owner's own annotations |
| `MainRevised.html` | the agreed desktop page, **full width** at 1800px |
| `Intro.html` | the introduction band open, and collapsed after the first search |
| `Cards.html` | the job card in six states, including the ones the app never drew |
| `Mobile.html` · `MobileSettings.html` · `MobileStats.html` | the phone views at 390px |
| `System.html` | every colour with its measured contrast ratio, the type ladder, the spacing rungs |
| `SearchSettings.html` · `SearchStats.html` | the settings row in both states, and the statistics window |
| `Login.html` · `Settings.html` · `Sources.html` · `Privacy.html` · `Admin.html` | the five other windows |

Every frame except `Main.html` was measured against the running app on 2026-09-22 or
2026-09-23 and redrawn at full width. `Main.html` is deliberately left alone: it is the
record of the page before the review, so its 11px text and its old verdict labels are the
faults it exists to document. An audit that flags it is working.

States that are drawn here and have never existed in the app: the introduction collapsed,
the job card selected-and-applied, the card overflow menu, `Local language required`,
Search settings refusing to run with no role, the delete button once both fields are
filled, and the administrator Indeed panel.

## The four language labels

The names changed on 2026-09-22 and the frames are the record of it:

| Label | What the gate actually established |
|---|---|
| **Definitely English** | enough of the ad was published, the text is predominantly English, no local language named as required |
| **Maybe English** | the whole ad was read and the language was still ambiguous — often “Dutch is a plus” |
| **Not sure** | the source published a preview, so there was never enough text to judge |
| **Local language required** | a local language is named as a requirement; never promoted into matches |

The middle two are easy to confuse, and the distinction is the actionable part: *Maybe
English* has nothing more to get, *Not sure* is usually settled by opening the original ad.
Any wording change has to keep that apart. Per #119 the interface must not claim a perfect
classification, which is the open question against **Definitely English**.

## Keeping the mirror current

```bash
npm run sync:design -- <dir-holding-the-.dc.html-frames>
```

That strips the artifact runtime's two script tags, writes one plain `.html` per frame and
regenerates `index.html` from `canvas.json`. Frames in this folder that the canvas no longer
has are reported, never deleted — removing one is a decision, not a sync step.

## Checking work against it

```bash
node scripts/check-design.mjs
```

That checks the part of the agreement a machine can settle: the token values, the five-size
ladder, the 12px floor, and the three structural changes (no rule under each filter row, no
box around the card, no bare `1fr` on a text column). It names every failure with the reason
the value is what it is, and exits non-zero. Drive it to zero.

It cannot check layout, hierarchy or whether the thing looks right. For the layout half:

```bash
npm run dev          # in one terminal
npm run check:visual  # in another
```

That drives a real browser, **signs itself in**, seeds one advertisement per verdict so the job
card is actually on screen, and measures both 1400x950 and 390x844: horizontal overflow per
element, text below 12px, controls under their tap floor, the sizes actually rendered, whether
every band starts at the same left edge, and how far down the first job sits. It needs no
password and no credential: it registers a throwaway account against the local server, the same
way `npm run verify:dev` does, and adds nothing to `package.json` — Node's own WebSocket drives
whichever Chrome or Edge is already installed.

Neither check can tell you whether a screen looks *right*. For that, open `index.html` beside the
running app and compare at **1400px and 375px**, signed in. This matters more here than on most projects:
**nothing tests `app/job-radar.tsx`**. Lint, typecheck, tests and build all pass on a page that
renders wrongly, so a green gate is not evidence that a screen is correct.

## What these frames are not

They are pictures. They carry no data, nothing is wired up, and the sample advertisements in
them are illustrative. Where a frame and a task disagree, **the task on the board is
authoritative** — it carries the exact values, and it says which parts are decided and which
are still open.

There is **no fit score**. CV matching was removed outright, so no frame may show one; an
earlier pass drew a “Fit 71” that does not exist anywhere in the product, and the sort
control offers Newest posted and Recently found only.

The statistics panel in these frames predates #124: it shows **Searched / Added /
Still open**, where Still open was never populated. The live panel now shows **New this
search / Matched this search / Total collected** instead. New and Matched come from the run
snapshot (`imported_count`, `matched_count` in `search_run_sources`); Total collected comes
from the server-retained collection (`queryCollectionTotals`), never from loaded pages or
summed found counts. Unknown renders as —, never as a false zero.

## Why the values are what they are

Colour was measured, not chosen. The old `--muted` `#657169` sat at **4.88** against the cream
ground while carrying nearly every piece of supporting text, and `--signal-neutral` `#9aa09a`
was **2.56**, which fails outright — that edge was invisible. The replacements are 7.20, 5.69,
4.60, 4.41 and 3.85. `System.html` shows each one against its ground with its ratio, which is
the frame to read first if you are wondering why a colour cannot simply be nudged.
