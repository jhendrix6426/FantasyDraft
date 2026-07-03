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

- `index.html` — landing page: header banner + tab bar (Scouting, Live Draft,
  Live Scoring, Draft History, Records). Tab-switching JS lives inline at the
  bottom of the file — clicking a `nav.tabs button` swaps `#tab-frame`'s `src`
  to `data-tab + '.html'`. Adding another tab is just a new button with a
  matching `data-tab` and HTML file. This header only wraps a page when it's
  reached *through* the tab bar (i.e. loaded inside `#tab-frame`) — GMs reach
  `live-draft.html`/`my-board.html` via a direct shareable link instead, which
  bypasses `index.html` entirely. Those pages (plus `live-scoring.html`, which
  can also be opened directly) detect this with `window.self === window.top`
  and render their own small `.site-nav` back-link row when true, so a GM
  arriving cold via their link isn't stranded with no way to reach the rest
  of the site. Don't add this to `draft-presentation.html`/
  `scoring-presentation.html` — those are deliberately chrome-free full-bleed
  broadcast views, always opened directly, never wrapped by `index.html`.
- `scouting.html` — the scouting tool. Self-contained single file (HTML/CSS/JS,
  no dependencies, no build). This is where most of the historical-stats work
  has happened.
- `records.js` — shared IIFE (`window.RecordsBook`) for all-time record-book
  computation (format/day high scores, win streaks, draft steals, etc.),
  loaded by `records.html`, `draft-history.html`, and `scouting.html` so the
  logic isn't triplicated. Takes the raw `nationals-history` `db` payload
  directly via `RecordsBook.compute(db)` — see its header comment for the
  full exported API.
- `records.html` — all-time record book UI, reads `records.js`.
- `draft-history.html` — past fantasy drafts (standings, draft order, per-year
  rosters), reads the same `nationals-history` API plus `records.js` for
  badges.
- `live-draft.html` — GM- and commissioner-facing live draft tool (see below).
- `my-board.html` — standalone GM-only view of a single GM's private draft
  board (see "GM draft boards" below), for keeping it open on its own
  tab/device separate from both `live-draft.html` and `scouting.html`. Not
  part of the tab system — opened directly by URL or via a link from
  `live-draft.html`'s board panel.
- `draft-presentation.html` — standalone OBS-facing broadcast view for the
  live draft (see below). Not part of the tab system — opened directly by URL.
- `live-scoring.html` — scorekeeper-facing live scoring entry tool (see
  "Live Scoring system" below).
- `scoring-presentation.html` — standalone OBS-facing broadcast view for live
  scoring (leaderboard + records-aware ticker). Not part of the tab system.
- `worker/` — the `fantasy-draft` Cloudflare Worker source, deployed
  separately from the site (see "Live Draft system" / "Live Scoring system").
- `assets/header.png` — transparent PNG logo mark (badge + wordmark) used in
  `index.html`'s header, displayed at 34px tall next to the tab bar. The
  header itself is a fixed 64px bar with a CSS (not image-based) glow
  backdrop — no other image assets are in use.

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
- No auth for spectators: `live-draft.html`'s landing screen has a third
  "Just Watching" option alongside GM/Commissioner that just links straight
  to `draft-presentation.html?year=...` — for anyone who wants to follow
  along without a GM token or commish key.

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
`GET /fantasy/players/:year` is public (no auth), which is what lets a GM's
own draft board (below) work before the draft has even started.

**GM draft boards**: each GM can pre-rank a private wishlist of players from
their own `live-draft.html?gm=...&token=...` link, usable both before the
commissioner starts the draft and during it. Stored server-side (not
`localStorage`) at KV key `board_<year>_<gmId>`, authenticated the same way
picks are (`X-GM-Token`), via `GET/PUT /fantasy/livedraft/:year/board` — this
is deliberate so the board follows the GM's link to whatever device they
actually draft from, not just the device they built it on. It's never
included in the public `/fantasy/livedraft/:year` response (that's read by
every GM and the broadcast view), only fetchable with that GM's own token, so
one GM's strategy stays invisible to the others. When it's that GM's turn,
board rows for still-available players get an inline Draft button, so the
board doubles as a fast-pick tool, not just a reference list.

A GM's session (`{gmId, gmToken, gmName, year}`) lives in `localStorage` under
the key `livedraft-gm`, set on login in `live-draft.html` or `my-board.html`.
Because `scouting.html`, `live-draft.html`, and `my-board.html` are all
same-origin, this session is shared across all three without any extra
plumbing — logging in on one logs you in on the others. `scouting.html`'s
per-player modal reads this session (read-only glance, no login flow lives
there) and shows an "Add to My Draft Board" / "Remove" toggle scoped to
whichever GM is logged in, so a GM can build their board while looking at the
real stats, not just names. `my-board.html` is the same board panel as
`live-draft.html`'s (full add/reorder/remove), minus the Draft button and
turn-order UI, for GMs who want their board open separately from both the
stats table and the draft itself — it also accepts a direct `?gm=...&token=...`
link, not just the shared session, so it works standalone on a fresh device.

**Resetting a draft**: `POST /fantasy/livedraft/:year/reset` (commish auth)
hard-resets `livedraft_<year>` back to the pre-draft default (no draft order,
roster size, player pool, or picks) — wired to a "Reset Draft to Pre-Draft"
button in the commissioner's Danger Zone panel, gated by typing the year to
confirm. It deliberately does **not** touch `gm_registry` or any
`board_<year>_<gmId>` entries, so the commissioner can rehearse a full mock
draft on the real year with the real GM links, then reset cleanly right
before the actual event without invalidating anyone's link or wiping the
boards they built during the rehearsal.

**Deploying worker changes**: `cd worker && wrangler deploy` (manual, no CI —
matches how the rest of this project deploys).

## Live Scoring system

A manual, round-by-round scoring tracker for Nationals weekend itself —
separate from (but complementary to) the Live Draft system above, sharing
the same `worker/` Worker and `FANTASY_DB` KV namespace. Built because there
was no reliable way to pull live results automatically from either a
spreadsheet or the tournament host's own site, so a human (a "scorekeeper,"
not necessarily the site owner) enters results into this tool as they
happen, regardless of where the official record lives.

`live-scoring.html`'s login screen has a "Just Watching?" option below the
scorekeeper passphrase field that needs no login and just opens
`scoring-presentation.html?year=...` in a new tab — for anyone (including the
scorekeeper's own second monitor, or a TV for the room) who wants the clean
read-only broadcast display without the entry UI. Mirrors the equivalent
"Just Watching" link on `live-draft.html`'s landing screen.

**Scoring model** — `scoring_config` (`GET /fantasy/config`, previously dead
scaffolding from the earlier scrapped project attempt, now live):
```js
{ win: 3, timeoutWin: 2, timeoutTie: 1.5, timeoutLoss: 1, loss: 0, rosterSize: 9, countPerDay: 7, ... }
```
A scorekeeper picks a player and a round result (Win/Timeout Win/Timeout
Tie/Timeout Loss/Loss — Redemption auto-awards byes as a full Win, so there's
no separate bye option); the point value is looked up server-side, never
trusted from the client. Spot-checked against real 2025 historical data
(`db.matches` + known `breakdown[].pts`) and confirmed to reproduce the
exact known totals once true draws (`winner: null`) are correctly read as a
Timeout Tie rather than a loss.

**Daily team total = sum of only the top `countPerDay` (7) of a team's 9
rostered players that day** — the bottom 2 are dropped, recomputed fresh
each day. A roster member with no entries that day counts as 0, same as a
bad performance; this is deliberate so players who only attend some days
don't inherently hurt a team, as long as 7 others are producing.

**Rosters come from the Live Draft system** (`livedraft_<year>`'s completed
`picks`, grouped by `gm`) — this feature assumes the year's draft was run
through `/fantasy/livedraft`, not a separately-defined roster. `players_<year>`
supplies each player's thu/fri/sat format registration, used to determine who's
eligible to score on a given day and which format their day's points count
toward.

**Auth is a separate credential from the commissioner key** — a
`SCOREKEEPER_KEY` Worker secret (`X-Scorekeeper-Key` header, same
`wrangler secret put` process as `COMMISH_KEY`), deliberately independent so
whoever's keeping score doesn't get commissioner powers over the live draft.
There's no dedicated login-verification endpoint; a wrong key is only
discovered on the first real write, surfacing as a 401 that forces
`live-scoring.html` back to its login screen.

**KV schema** — `livescore_<year>`:
```js
{
  thu: { status: 'active'|'final', entries: [ {id, player, result, pts, ts} ], finalizedAt },
  fri: { ... }, sat: { ... }
}
```
`GET /fantasy/livescore/:year` (public) joins this with `livedraft_<year>`
and `players_<year>` and returns the full computed rollup (`teams[].dayTotals`,
`seasonTotal`) — this is centralized server-side in `computeLivescoreState()`
so `live-scoring.html` and `scoring-presentation.html` don't each reimplement
the top-7-of-9 math. `POST .../entry` (scorekeeper), `DELETE .../entry/:id`
(scorekeeper — corrections matter more here than in the draft, since live
scorekeeping under time pressure produces more mistakes than the slower,
deliberate draft did), and `POST .../:day/finalize|unfinalize` (scorekeeper)
round out the endpoints.

**`scoring-presentation.html`'s ticker** cross-references live entries
against `records.js`'s all-time `formatHighScore` thresholds (grouping a
day's entries by each player's registered format for that day) to surface
"closing in on / matched the all-time record" callouts, alongside a live
individual point leader and (once a day is finalized) a recap of who led
it. The historical `pts` values and this live formula were confirmed to come
from the same underlying scoring model, but treat exact-value matches as
approximate, not guaranteed identical.

`live-scoring.html` reuses `live-draft.html`'s focus-preservation `render()`
pattern (snapshot the focused element's value/selection before an
`innerHTML` swap, restore after) plus model-syncing the player-search input
via `oninput` — without both halves of that fix, the 3s poll loop steals
focus and blanks the search box mid-keystroke, exactly like the bug already
hit and fixed in the draft's commissioner GM-roster editor.

**Two related bugs found during pre-event testing, both from the same root
cause** (background polling rebuilding the page mid-interaction) **— fixed in
`live-draft.html` and `my-board.html`:**
- The GM player-search box wasn't actually model-synced (unlike
  `live-scoring.html`'s, which was correct from the start) — `renderGmView()`
  called `renderPlayerRows(available)` with no filter, so every 3s poll
  quietly replaced the filtered list with the full unfiltered pool while the
  search box still showed the typed text, unnoticed until a GM drafted
  whatever the top row now was. Fixed by adding `state.search`, using it in
  both the template's `value=` and the `renderPlayerRows` call, so the
  correct filtered list renders no matter what triggered that render.
- A background poll can also destroy a `<select>` while its native dropdown
  is open (e.g. the commissioner's draft-order picker), which reads as the
  selection/cursor randomly glitching. Fixed generically: `fetchLivedraft()`
  (and `my-board.html`'s poll) takes an `isBackgroundPoll` flag and skips the
  render — not the fetch, so data still stays fresh — whenever
  `document.activeElement` is an `INPUT`/`SELECT`/`TEXTAREA` inside `#app`.
  Direct, user-triggered renders (clicking a button, selecting a GM,
  submitting a pick) are unaffected and still render immediately; only the
  timer-driven background tick defers. If you add another poll loop or
  another dropdown/text field to either file, this guard already covers it —
  no per-widget patching needed.

**Drafting a player requires confirming a native `confirm()` dialog** ("Draft
{name}?") in `submitPick()` — covers both the main available-players list and
drafting straight from a GM's board, added after a mock draft produced a
misclick under the search bug above. Keep this even now that the search bug
is fixed — it's cheap insurance against fat-fingering the wrong row during a
live event.

## Working on this project

No build step — edit the HTML files directly, then verify in a real browser
before pushing (Playwright + a local `python3 -m http.server` works well; the
scouting page needs to be served over http:// for its `fetch()` to behave
consistently, though it does work in most cases over file:// too). Push to
`main` to deploy; GitHub Pages typically takes 1-2 minutes to update.
