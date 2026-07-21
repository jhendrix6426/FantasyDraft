// Shared draft-history sourcing/verification, loaded by draft-history.html,
// scouting.html, and records.html (same window.FantasyHistory IIFE pattern
// as records.js's window.RecordsBook). Two independent pieces:
//
//   mergeWorkerDraftHistory(db, year, apiBase) — pulls the current year's
//   fantasyDraft (roster + hand-entered live-scoring totals) straight from
//   the fantasy-draft Worker instead of requiring it be hand-transcribed
//   into nationals-history after the fact. No-ops until the commissioner has
//   finalized that year's draft (see live-draft.html's Finalize Draft).
//
//   reconcileWithOfficialResults(db, year) — once official Nationals match
//   results exist in nationals-history for that year, recomputes each
//   drafted player's per-format point total from those official matches and
//   compares it to the hand-entered value already in db.tournaments[year]
//   .fantasyDraft. Matches become canonical (verified: true); anything that
//   doesn't match stays on the hand-entered value with verified: false plus
//   the computed officialPts, for draft-history.html to flag rather than
//   silently overwrite a possibly-wrong "official" number.
(function (global) {
  // Regular-season (non-Top-Cut) target score per verbose format name — a
  // match's winner reaching this score is a clean Win; below it is a Timeout
  // Win (time expired before either player closed it out). No winner at all
  // (drawn territory at timeout) is a Timeout Tie for both players.
  const TARGET_SCORE = {
    'T1 2-Player': 5, 'Teams': 5, 'Type A': 5, 'Booster Draft': 5, 'Sealed': 5, 'T2 2-Player': 7,
  };
  const RESULT_PTS = { win: 3, timeoutWin: 2, timeoutTie: 1.5, timeoutLoss: 1, loss: 0 };

  function r1(n) { return Math.round(n * 10) / 10; }

  function parseRoundNum(str) {
    if (!str) return 0;
    const m = String(str).match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }

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
    t.fantasyDraft = { teams: data.teams };
  }

  // Recomputes one player's official point total for one format+year from
  // db.matches, excluding Top Cut bracket play (a one-time 2024 fixture,
  // scored separately and not modeled here) and correcting for two quirks
  // confirmed against real historical data: Teams (doubles) format logs the
  // same physical game once per teammate as playerA, both rows carrying an
  // identical score, so duplicate rows sharing a round are collapsed to one;
  // byes have no match row at all (Redemption auto-awards a bye as a full
  // Win), detected by comparing this player's round count against the max
  // round number seen across the whole format+year.
  function computeOfficialFormatScore(db, year, format, playerName) {
    const target = TARGET_SCORE[format];
    if (!target || !db || !db.matches) return null;
    const all = db.matches[`${year}_${format}`] || [];
    const regular = all.filter(m => !m.topCut);
    if (!regular.length) return null;

    const mine = regular.filter(m => m.playerA === playerName || m.playerB === playerName);
    if (!mine.length) return null;

    const byRound = {};
    for (const m of mine) if (!byRound[m.round]) byRound[m.round] = m;

    let total = 0;
    for (const m of Object.values(byRound)) {
      if (m.scoreA === null || m.scoreB === null || m.scoreA === undefined || m.scoreB === undefined) continue;
      const meA = m.playerA === playerName;
      const myScore = meA ? m.scoreA : m.scoreB;
      const oppScore = meA ? m.scoreB : m.scoreA;
      const winner = m.winner;
      let result;
      if (!winner) result = 'timeoutTie';
      else if (winner === playerName) result = myScore >= target ? 'win' : 'timeoutWin';
      else result = oppScore >= target ? 'loss' : 'timeoutLoss';
      total += RESULT_PTS[result];
    }

    const expectedRounds = regular.reduce((max, m) => Math.max(max, parseRoundNum(m.round)), 0);
    const missingRounds = Math.max(0, expectedRounds - Object.keys(byRound).length);
    total += missingRounds * RESULT_PTS.win; // each missing round assumed a bye (auto full Win)

    return r1(total);
  }

  function reconcileWithOfficialResults(db, year) {
    if (!db || !Array.isArray(db.tournaments)) return;
    const t = db.tournaments.find(t => t.year === Number(year));
    if (!t || !t.fantasyDraft || !Array.isArray(t.fantasyDraft.teams)) return;

    for (const team of t.fantasyDraft.teams) {
      for (const player of team.players) {
        if (!Array.isArray(player.breakdown)) continue;
        for (const entry of player.breakdown) {
          const official = computeOfficialFormatScore(db, year, entry.format, player.name);
          if (official === null) continue; // can't verify this format (e.g. no official data loaded yet)
          if (Math.abs(official - entry.pts) < 0.01) {
            entry.pts = official;
            entry.verified = true;
          } else {
            entry.verified = false;
            entry.officialPts = official;
          }
        }
        // Player total re-sums from (possibly corrected) breakdown lines.
        // Team pts is left as-is (already computed with the top-N-per-day
        // roster rule by the Worker in mergeWorkerDraftHistory) — reconciling
        // rarely changes anything in the common case, and any real dispute is
        // exactly what the per-line verified:false flag exists to surface.
        player.pts = r1(player.breakdown.reduce((s, b) => s + b.pts, 0));
      }
    }
  }

  global.FantasyHistory = { mergeWorkerDraftHistory, reconcileWithOfficialResults };
})(window);
