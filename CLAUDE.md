# FantasyDraft

Hobby project for a fantasy draft built around a tabletop CCG's ("Redemption")
annual Nationals tournament. Players are drafted onto fantasy teams before
Nationals, then scored on their real tournament performance. The frontend is
a static site (no build step) deployed on GitHub Pages. There is now also a
small Cloudflare Worker backend (`worker/`) powering the live draft feature —
see "Live Draft system" below. Everything else (scouting, standings) stays
static/read-only with no backend of its own.

Live site: https://jhendrix6426.github.io/FantasyDraft/
Repo: https://github.com/jhendrix6426/FantasyDraft — pushing to `main` auto-deploys.

## Structure

- `index.html` — landing page: header banner + tab bar (Scouting, Live Draft).
  Tab-switching JS lives inline at the bottom of the file — clicking a
  `nav.tabs button` swaps `#tab-frame`'s `src` to `data-tab + '.html'`. Adding
  another tab is just a new button with a matching `data-tab` and HTML file.
- `scouting.html` — the scouting tool. Self-contained single file (HTML/CSS/JS,
  no dependencies, no build). This is where most of the historical-stats work
  has happened.
- `live-draft.html` — GM- and commissioner-facing live draft tool (see below).
- `draft-presentation.html` — standalone OBS-facing broadcast view for the
  live draft (see below). Not part of the tab system — opened directly by URL.
- `worker/` — the `fantasy-draft` Cloudflare Worker source, deployed
  separately from the site (see "Live Draft system").
- `assets/header-small.png` — compact (900×220) transparent PNG logo mark
  (badge + wordmark) used in `index.html`'s header, displayed at 34px tall
  next to the tab bar. The header itself is a fixed 64px bar with a CSS
  (not image-based) glow backdrop — no other image assets are in use.

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

## Live Draft system

A real-time, multi-device live draft, separate from the read-only
`nationals-history` API used by `scouting.html` — this one has its own
backend, `worker/` (Cloudflare Worker `fantasy-draft`, deployed at
`https://fantasy-draft.jhendrix6426.workers.dev`, single KV namespace
`FANTASY_DB`). It was built from a scrapped earlier attempt at this project
(originally at `~/fantasy-draft-worker/`, now moved into this repo).

**Auth** (there is none of this on the `nationals-history` API — don't
confuse the two):
- Commissioner actions (GM roster, scoring config, player pools, draft
  start/pause/resume/undo) require an `X-Commish-Key` header matching the
  `COMMISH_KEY` Worker secret. Set via `wrangler secret put COMMISH_KEY` from
  `worker/` — it is **not** stored anywhere in this repo, only in Cloudflare.
- GM pick submission requires `X-GM-Token` + `gmId` in the body, checked
  against a `token` field on that GM's `gm_registry` entry. `GET /fantasy/gms`
  strips tokens from the response (public); `GET /fantasy/gms?full=1` (commish
  auth) returns them, for the roster editor in `live-draft.html`. Commissioner
  UI generates each GM a shareable link (`live-draft.html?gm=id&token=...`)
  rather than making them type a token.

**Turn order is derived, never stored** — `computeTurn()` in `worker.js`
recomputes the on-the-clock GM from `picks.length` and `draftOrder` (snake:
reverses every round) on every request. There is no `currentPick` field to
desync from the picks array.

**Key endpoints** (see `worker/worker.js` for the full list): `GET
/fantasy/livedraft/:year` (public, includes derived `onTheClock`/`round`/
`pickNumber`/`isComplete`/`onDeck`), `POST .../start|pause|resume|undo`
(commish), `POST .../pick` (GM token — validates turn order, player-pool
membership, and de-dupes via a client-generated `pickRequestId` so a
retried/double-submitted request replays the same result instead of erroring
or double-picking).

**Race conditions**: KV has no compare-and-swap. Given a small trusted GM
group and turn-gating already limiting writes to one authorized GM at a time,
this is handled pragmatically rather than with Durable Objects — idempotent
`pickRequestId` replay covers accidental double-submits, and commissioner
`undo` is the manual fallback for the rare residual case. Both `live-draft.html`
and `draft-presentation.html` poll every 2-3s, so a bad pick would surface
almost immediately.

**Player pool**: the commissioner pastes a JSON array (matching `scouting.html`'s
`PLAYERS` shape) into `live-draft.html`'s Player Pool panel, which `PUT`s it to
`/fantasy/players/:year`. There's no automatic sync from `scouting.html`'s
hardcoded `PLAYERS` array — copy/paste it manually before a draft.

**Deploying worker changes**: `cd worker && wrangler deploy` (manual, no CI —
matches how the rest of this project deploys).

## Working on this project

No build step — edit the HTML files directly, then verify in a real browser
before pushing (Playwright + a local `python3 -m http.server` works well; the
scouting page needs to be served over http:// for its `fetch()` to behave
consistently, though it does work in most cases over file:// too). Push to
`main` to deploy; GitHub Pages typically takes 1-2 minutes to update.
