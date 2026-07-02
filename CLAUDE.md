# FantasyDraft

Hobby project for a fantasy draft built around a tabletop CCG's ("Redemption")
annual Nationals tournament. Players are drafted onto fantasy teams before
Nationals, then scored on their real tournament performance. This repo is a
static site (no build step, no backend) deployed on GitHub Pages.

Live site: https://jhendrix6426.github.io/FantasyDraft/
Repo: https://github.com/jhendrix6426/FantasyDraft — pushing to `main` auto-deploys.

## Structure

- `index.html` — landing page: header banner + tab bar. Currently only one
  tab ("Scouting"), which loads `scouting.html` in an iframe. Built to have
  more tabs added later (draft board, standings, etc. — not built yet).
- `scouting.html` — the actual scouting tool. Self-contained single file
  (HTML/CSS/JS, no dependencies, no build). This is where almost all the work
  has happened so far.
- `assets/logo.png` — the original square Fantasy Draft badge (black/red/gold),
  source of the site's color palette. No longer used directly in either page,
  but kept as the canonical brand mark.
- `assets/header-elements.png` — wide (2400×600) transparent PNG of just the
  wordmark/bracket linework from the badge, stretched full-width. This is the
  foreground layer of `index.html`'s header.
- `assets/header-banner.svg` — hand-authored backdrop (dark base + red/gold
  radial glows + dot texture + bottom accent bar) sized to the same 2400×600
  canvas, sits behind `header-elements.png` via CSS. Regenerate this if the
  palette changes; it's the only header asset that's code (not a design file).
- `assets/header-graphic.png` — an earlier, fully-opaque full-width version of
  the header banner (same wordmark, but with the badge's dark chevron texture
  baked in instead of the glow). No longer referenced by either page; kept
  around as a design alternate.

## Data source

Everything is fetched client-side on page load from a Cloudflare Worker:
`https://nationals-history.jhendrix6426.workers.dev/nationals/db`

That single JSON payload contains:
- `results` — per-tournament placements/points by format (`"2025_T1 2-Player"` style keys)
- `matches` — round-by-round match results (winner, scores, opponents), same key format as `results`
- `tournaments[]` — one entry per Nationals year, including `tournaments[].fantasyDraft`
  for years that had a fantasy draft (currently 2024 and 2025)
- `players` — flat name registry, not used for stats
- `multiWL` — not currently used

**Data pool policy: everything is 2022 onward, no exceptions.** There used to
be a special case excluding 2022 "Teams" format data (low turnout that year),
but that was deliberately removed — the tool now always uses the full 2022+
pool for every format, including Teams. Don't reintroduce a per-format year
exception without being asked.

Format codes used throughout: `T1` (Type 1), `T2` (Type 2), `BD` (Booster
Draft), `SD` (Sealed), `Teams`, `TA` (Type A). `FMT_MAP` in `scouting.html`
translates the API's verbose format names into these codes; `FMT_TO_DAY` maps
each format to the tournament day it's played (Thu/Fri/Sat).

Name matching between datasets (API uses full names, sometimes with nickname
variants like "Mitch"/"Mitchell") is handled by `namesMatch()` — it requires
exact last-name match plus first-name match-or-prefix. If a player's stats
seem to be missing, check whether their name needs a normalization rule added
to `normName()`.

## The PLAYERS list is manually maintained

The `PLAYERS` array in `scouting.html` (2026 Nationals attendees + their
Thu/Fri/Sat format registrations) is hardcoded, not fetched. There's a
registration system at a separate site, but it's behind an auth wall the
scraper can't get through. The user pulls fresh registration data manually
and pastes updated entries into the array as the field fills in. Each entry:

```js
{name:'Player Name', thu:'BD', fri:'T1', sat:'Teams', days:3, firstNats:false}
```

`thu`/`fri`/`sat` are format codes or `null` if not playing that day; `days`
is the count of non-null days.

## Fantasy draft history is live, not hardcoded

`DD` (fantasy draft results by year) used to be a hardcoded object. It's now
built at runtime by `processFantasyDraft()` from `tournaments[].fantasyDraft`,
so new draft years appear automatically once the API has them — no code
changes needed. Champion is derived as the team with the highest `pts`.

## Scouting table features

- Per-player Nationals stats (personal avg vs. pool avg, by day/format),
  Win/Loss match record, and fantasy draft history — all in a sortable/
  filterable table, with a per-player modal for full detail.
- **Customizable columns**: users toggle which stat columns are visible via
  the "Customize" panel. Preference persists in `localStorage`
  (`scouting-visible-cols`).
- **Draft Score**: a weighted composite ranking (-3 to 3 weight per stat:
  Total Avg, Win%, Fantasy Slot Delta). Missing data scores as neutral (50),
  not zero — first-time attendees shouldn't get punished for lacking history.
  Weights persist in `localStorage` (`scouting-score-weights`). See
  `computeScores()` if touching this.
- Adding a new column: add an entry to `COLUMN_DEFS` (id, label, optional
  sortKey, render function) — the table header/rows/toggle panel are all
  generated from that array, nothing else needs to change.

## Design system

Dark sporty/tech theme pulled from the logo: near-black background, red/gold
gradient accents, radial glow lighting. Fonts via Google Fonts: **Oswald**
(headers, labels, buttons — condensed/athletic) and **JetBrains Mono** (all
data/stats — keeps numbers aligned, terminal/scoreboard feel). Format badges
are color-coded pills (cyan/red/green/gold/purple/orange per format). Keep
`index.html`'s tab bar styling in sync with `scouting.html` if the palette
changes — they're meant to feel like one product.

## Working on this project

No build step — edit the HTML files directly, then verify in a real browser
before pushing (Playwright + a local `python3 -m http.server` works well; the
scouting page needs to be served over http:// for its `fetch()` to behave
consistently, though it does work in most cases over file:// too). Push to
`main` to deploy; GitHub Pages typically takes 1-2 minutes to update.
