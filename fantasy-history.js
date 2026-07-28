// Shared draft-history sourcing, loaded by draft-history.html, scouting.html,
// and records.html (same window.FantasyHistory IIFE pattern as records.js's
// window.RecordsBook).
//
//   mergeWorkerDraftHistory(db, year, apiBase) — pulls the current year's
//   fantasyDraft (roster + point totals) straight from the fantasy-draft
//   Worker instead of requiring it be hand-transcribed into nationals-history
//   after the fact. No-ops until the commissioner has finalized that year's
//   draft (see live-draft.html's Finalize Draft).
//
// Official-results verification against Tim's site (the source of truth for
// Nationals results — see CLAUDE.md) now happens server-side, via the
// Commissioner Tools "Verify Against Official Results" button in
// live-draft.html, which calls POST /fantasy/livedraft/:year/verify-official.
// That endpoint persists the result, and computeFantasyDraftHistory
// (worker.js) automatically prefers it over hand-entered live-scoring totals
// wherever it found a match — so by the time mergeWorkerDraftHistory below
// fetches .../history, any verification that's already been run is already
// baked into the numbers and each breakdown[] entry's `verified` flag. There
// used to be a client-side recompute-from-matches version of this check here
// too, pointed at the separate nationals-history API — removed once that
// API stopped being where official 2026+ results actually get entered (see
// CLAUDE.md's "Official-Results Verification" section for why).
(function (global) {
  async function mergeWorkerDraftHistory(db, year, apiBase) {
    if (!db || !year || !apiBase) return;
    let data;
    try {
      const res = await fetch(`${apiBase}/fantasy/livedraft/${year}/history`);
      if (!res.ok) return; // not finalized yet, or no draft for this year — fail soft
      data = await res.json();
    } catch (e) { return; } // network error — fail soft, same as every other Worker call in scouting.html

    if (!data || !Array.isArray(data.teams)) return;
    if (!Array.isArray(db.tournaments)) db.tournaments = [];
    let t = db.tournaments.find(t => t.year === Number(year));
    if (!t) { t = { year: Number(year) }; db.tournaments.push(t); }
    t.fantasyDraft = { teams: data.teams, officialVerifiedAt: data.officialVerifiedAt || null };
  }

  global.FantasyHistory = { mergeWorkerDraftHistory };
})(window);
