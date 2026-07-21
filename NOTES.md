# Working Notes — 2026 Season Prep

Running notes on open threads from ongoing chats about this repo, so we can
pick back up without re-deriving context. Not permanent documentation — fold
anything durable into `CLAUDE.md` once it's actually built, and delete the
entry here.

## Open item: streamline scouting list <-> live-draft player pool sync

**Problem:** `scouting.html`'s `PLAYERS` array and the live draft's player
pool (`players_<year>` in the `fantasy-draft` Worker, edited via
`live-draft.html`'s Player Pool panel) are two separate manually-maintained
lists. As 2026 registrations trickle in, both have to be updated by hand,
and the Player Pool panel does a **full replace** with whatever's pasted in
(`live-draft.html:604`, `worker.js:352`) — pasting only new additions (not
the full list) silently wipes everyone else out.

**Direction agreed on (not yet built):**
- Pull `PLAYERS` out of `scouting.html`'s inline array into a standalone
  JSON file that `scouting.html` fetches instead of inlining.
- Add a **"Load from Scouting List"** button to `live-draft.html`'s Player
  Pool panel that fetches that same JSON file and pre-fills/saves it in one
  click, instead of copy/paste.
- Deliberately **not** having the Worker auto-pull the list live at
  `/start` time (no button at all) — that would add a network dependency
  and remove the commissioner's chance to review the list before it's
  frozen for the live event. The one-click button keeps that review step.

**Status:** proposed, user hadn't confirmed go-ahead yet when the
conversation moved to end-of-season questions.

## Resolved: end-of-season workflow (Finalize Draft + Worker-sourced history)

Both gaps identified in this item are now built — see `CLAUDE.md`'s "Draft
Finalization" and "Draft History Is Sourced From This Worker, Verified
Against Official Results" sections for the shipped design. Deleting this
entry per this file's own header policy.
