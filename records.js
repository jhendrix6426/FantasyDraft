// Shared record-book computation, loaded by records.html, draft-history.html,
// and scouting.html. Wrapped in an IIFE exposing window.RecordsBook so it
// can't collide with each page's own top-level FMT_MAP/namesMatch copies.
//
// Every record is scoped to players who were actually drafted onto a fantasy
// team that year (i.e. present in DD, built from tournaments[].fantasyDraft,
// which only exists 2024+). This is deliberate: Nats performances outside a
// draft context never count toward a record.
(function (global) {
  const FMT_MAP = {
    'T1 2-Player':'T1','T2 2-Player':'T2','Booster Draft':'BD',
    'Sealed':'SD','Teams':'Teams','Type A':'TA','Booster Draft (Multi)':'BD'
  };
  const FMT_LABEL = {T1:'Type 1',T2:'Type 2',BD:'Booster',SD:'Sealed',Teams:'Teams',TA:'Type A'};
  const FMT_TO_DAY = {BD:'thu',T2:'thu',T1:'fri',TA:'fri',SD:'sat',Teams:'sat'};
  const DAY_LABEL = {thu:'Thu',fri:'Fri',sat:'Sat'};
  const DAY_ORDER = ['thu','fri','sat'];
  const MIN_WINPCT_MATCHES = 5;

  function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : null; }
  function r1(n) { return n!==null && n!==undefined ? Math.round(n*10)/10 : null; }

  function normName(n) {
    return n.toLowerCase().trim().replace(/\s+/g,' ')
      .replace(/\bmitch\b/,'mitchell')
      .replace(/jayden alstand/,'jayden alstad')
      .replace(/dario dante villanova/,'dario dante villanova')
      .replace(/^dario villanova$/,'dario dante villanova')
      .replace(/^jacob antonetz$/,'jake antonetz');
  }
  function namesMatch(a,b) {
    const na=normName(a), nb=normName(b);
    if(na===nb) return true;
    const pa=na.split(' '), pb=nb.split(' ');
    if(pa.length<2 || pb.length<2) return false;
    if(pa[pa.length-1] !== pb[pb.length-1]) return false;
    const fa=pa[0], fb=pb[0];
    return fa===fb || fa.startsWith(fb) || fb.startsWith(fa);
  }

  function parseRound(str) {
    if (!str) return 0;
    const m = String(str).match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }

  function processFantasyDraft(db) {
    const DD = {};
    if (!db || !db.tournaments) return DD;
    for (const t of db.tournaments) {
      if (!t.fantasyDraft || !t.fantasyDraft.teams || !t.fantasyDraft.teams.length) continue;
      const teams = t.fantasyDraft.teams.map(team => ({
        gm: team.gm,
        pts: team.pts,
        players: team.players.map(p => ({ name: p.name, pts: p.pts, pick: p.draftPick, breakdown: p.breakdown || [] }))
      }));
      const champion = teams.reduce((best, tm) => tm.pts > best.pts ? tm : best, teams[0]).gm;
      DD[t.year] = { champion, teams };
    }
    return DD;
  }

  // Flat list of every drafted player-season: {player, year, gm, pts, pick, breakdown}
  function draftedPlayerSeasons(DD) {
    const out = [];
    for (const [yr, data] of Object.entries(DD)) {
      const year = parseInt(yr, 10);
      for (const team of data.teams) {
        for (const p of team.players) {
          out.push({ player: p.name, year, gm: team.gm, pts: p.pts, pick: p.pick, breakdown: p.breakdown || [] });
        }
      }
    }
    return out;
  }

  function matchesForYear(db, year) {
    const out = [];
    if (!db || !db.matches) return out;
    for (const [key, matchList] of Object.entries(db.matches)) {
      if (parseInt(key.split('_')[0], 10) !== year) continue;
      const fmt = FMT_MAP[key.split('_').slice(1).join('_')];
      if (!fmt) continue;
      for (const m of matchList) out.push({ ...m, fmt });
    }
    return out;
  }

  // Player's decisive (winner present) matches for one year — matches the
  // app's usual convention of silently dropping ties/byes. Used for win%.
  function decisiveMatchesForPlayerYear(db, playerName, year) {
    const out = [];
    for (const m of matchesForYear(db, year)) {
      if (!m.playerA || !m.playerB || !m.winner) continue;
      if (namesMatch(m.playerA, playerName)) out.push({ win: m.playerA === m.winner });
      else if (namesMatch(m.playerB, playerName)) out.push({ win: m.playerB === m.winner });
    }
    return out;
  }

  // Player's full chronological match sequence across every drafted year,
  // INCLUDING ties/draws as explicit results — needed only for the win-streak
  // record, where a draw breaks the streak (unlike every other stat in this
  // codebase, which excludes no-winner matches entirely).
  function fullMatchSequenceForPlayer(db, playerName, draftedYears) {
    const seq = [];
    for (const year of draftedYears) {
      for (const m of matchesForYear(db, year)) {
        if (!m.playerA || !m.playerB) continue; // true bye / no opponent, not a result
        let result = null;
        if (namesMatch(m.playerA, playerName)) result = m.winner ? (m.playerA === m.winner ? 'W' : 'L') : 'D';
        else if (namesMatch(m.playerB, playerName)) result = m.winner ? (m.playerB === m.winner ? 'W' : 'L') : 'D';
        if (!result) continue;
        const opp = namesMatch(m.playerA, playerName) ? m.playerB : m.playerA;
        seq.push({ year, day: FMT_TO_DAY[m.fmt] || 'zzz', round: parseRound(m.round), result, fmt: m.fmt, opp });
      }
    }
    seq.sort((a, b) => a.year - b.year || DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || a.round - b.round);
    return seq;
  }

  // W/L/D for a player in a single year, across every format they played
  // that year (ties counted, unlike the rest of the app's match stats).
  function winLossDrawForPlayerYear(db, playerName, year) {
    let w = 0, l = 0, d = 0;
    const byFmt = {};
    for (const m of matchesForYear(db, year)) {
      if (!m.playerA || !m.playerB) continue;
      let mine = null;
      if (namesMatch(m.playerA, playerName)) mine = 'A';
      else if (namesMatch(m.playerB, playerName)) mine = 'B';
      if (!mine) continue;
      if (!byFmt[m.fmt]) byFmt[m.fmt] = { w: 0, l: 0, d: 0 };
      if (!m.winner) { d++; byFmt[m.fmt].d++; continue; }
      const won = (mine === 'A' && m.playerA === m.winner) || (mine === 'B' && m.playerB === m.winner);
      if (won) { w++; byFmt[m.fmt].w++; } else { l++; byFmt[m.fmt].l++; }
    }
    return { w, l, d, byFmt };
  }

  // "Top Cut" (and any other bonus category not in FMT_MAP) is a cross-format
  // playoff bonus, not a format in its own right — excluded from this record.
  function computeFormatHighScores(seasons) {
    const out = {};
    for (const s of seasons) {
      for (const b of s.breakdown) {
        const fmt = FMT_MAP[b.format];
        if (!fmt) continue;
        if (!out[fmt] || b.pts > out[fmt].pts) out[fmt] = { player: s.player, year: s.year, pts: b.pts, fmt };
      }
    }
    return out;
  }

  function computeDayHighScores(seasons) {
    const out = {};
    for (const s of seasons) {
      for (const b of s.breakdown) {
        const fmt = FMT_MAP[b.format];
        if (!fmt) continue;
        const day = FMT_TO_DAY[fmt];
        if (!day) continue;
        if (!out[day] || b.pts > out[day].pts) out[day] = { player: s.player, year: s.year, pts: b.pts, fmt, day };
      }
    }
    return out;
  }

  function computeSeasonTotal(seasons) {
    let best = null;
    for (const s of seasons) if (!best || s.pts > best.pts) best = { player: s.player, year: s.year, pts: s.pts };
    return best;
  }

  function computeMostWins(db, seasons) {
    let best = null;
    for (const s of seasons) {
      const records = decisiveMatchesForPlayerYear(db, s.player, s.year);
      if (!records.length) continue;
      const wins = records.filter(r => r.win).length;
      if (!best || wins > best.wins) {
        best = { player: s.player, year: s.year, wins, losses: records.length - wins, matches: records.length };
      }
    }
    return best;
  }

  function computeSeasonWinPct(db, seasons) {
    let best = null;
    for (const s of seasons) {
      const records = decisiveMatchesForPlayerYear(db, s.player, s.year);
      if (records.length < MIN_WINPCT_MATCHES) continue;
      const wins = records.filter(r => r.win).length;
      const pct = wins / records.length * 100;
      if (!best || pct > best.pct || (pct === best.pct && records.length > best.matches)) {
        best = { player: s.player, year: s.year, wins, losses: records.length - wins, matches: records.length, pct: Math.round(pct) };
      }
    }
    return best;
  }

  function computeWinStreak(db, seasons) {
    const yearsByPlayer = {};
    for (const s of seasons) {
      if (!yearsByPlayer[s.player]) yearsByPlayer[s.player] = new Set();
      yearsByPlayer[s.player].add(s.year);
    }
    let best = null;
    for (const [player, yearsSet] of Object.entries(yearsByPlayer)) {
      const years = [...yearsSet].sort((a, b) => a - b);
      const seq = fullMatchSequenceForPlayer(db, player, years);
      let run = [], longestRun = [];
      for (const entry of seq) {
        if (entry.result === 'W') {
          run.push(entry);
          if (run.length > longestRun.length) longestRun = run.slice();
        } else {
          run = [];
        }
      }
      if (longestRun.length > 0 && (!best || longestRun.length > best.length)) {
        const active = seq.length > 0 && longestRun[longestRun.length - 1] === seq[seq.length - 1];
        best = {
          player, length: longestRun.length,
          startYear: longestRun[0].year, endYear: longestRun[longestRun.length - 1].year,
          active, entries: longestRun
        };
      }
    }
    return best;
  }

  function computeTeamScore(DD) {
    let best = null;
    for (const [yr, data] of Object.entries(DD)) {
      const year = parseInt(yr, 10);
      for (const team of data.teams) if (!best || team.pts > best.pts) best = { gm: team.gm, year, pts: team.pts };
    }
    return best;
  }

  // Biggest positive "slot delta" — reuses the exact windowed-average formula
  // from scouting.html's openModal fantasy-history section.
  function computeDraftSteal(DD) {
    let best = null;
    for (const [yr, data] of Object.entries(DD)) {
      const year = parseInt(yr, 10);
      const allPicks = data.teams.flatMap(t => t.players.map(p => ({ ...p, gm: t.gm })));
      allPicks.sort((a, b) => a.pick - b.pick);
      const total = allPicks.length;
      const half = 4;
      for (const pick of allPicks) {
        const wStart = Math.max(1, pick.pick - half);
        const wEnd = Math.min(total, Math.max(wStart + 7, pick.pick + half - 1));
        const window = allPicks.filter(pk => pk.pick >= wStart && pk.pick <= wEnd && pk !== pick);
        const windowAvg = window.length ? r1(avg(window.map(pk => pk.pts))) : pick.pts;
        const delta = r1(pick.pts - windowAvg);
        if (!best || delta > best.delta) {
          best = {
            player: pick.name, year, gm: pick.gm, pick: pick.pick, pts: pick.pts, delta, windowAvg,
            window: window.map(pk => ({ player: pk.name, pick: pk.pick, pts: pk.pts })).sort((a, b) => a.pick - b.pick)
          };
        }
      }
    }
    return best;
  }

  function compute(db) {
    const DD = processFantasyDraft(db);
    const seasons = draftedPlayerSeasons(DD);
    return {
      DD,
      formatHighScore: computeFormatHighScores(seasons),
      dayHighScore: computeDayHighScores(seasons),
      seasonTotal: computeSeasonTotal(seasons),
      mostWins: computeMostWins(db, seasons),
      seasonWinPct: computeSeasonWinPct(db, seasons),
      winStreak: computeWinStreak(db, seasons),
      teamScore: computeTeamScore(DD),
      draftSteal: computeDraftSteal(DD)
    };
  }

  // Every record a given player currently holds (as a player, or as a GM for
  // the team-score record) — for scouting.html's "Records Held" section.
  function recordsForPlayer(book, playerName) {
    const out = [];
    for (const [fmt, r] of Object.entries(book.formatHighScore)) {
      if (namesMatch(r.player, playerName)) out.push({ label: `Best ${FMT_LABEL[fmt] || fmt} Score`, value: `${r.pts} pts`, year: r.year });
    }
    for (const [day, r] of Object.entries(book.dayHighScore)) {
      if (namesMatch(r.player, playerName)) out.push({ label: `Best ${DAY_LABEL[day] || day} Score`, value: `${r.pts} pts (${FMT_LABEL[r.fmt] || r.fmt})`, year: r.year });
    }
    if (book.seasonTotal && namesMatch(book.seasonTotal.player, playerName)) {
      out.push({ label: 'Highest Season Total', value: `${book.seasonTotal.pts} pts`, year: book.seasonTotal.year });
    }
    if (book.mostWins && namesMatch(book.mostWins.player, playerName)) {
      out.push({ label: 'Most Wins (Season)', value: `${book.mostWins.wins} wins (${book.mostWins.wins}-${book.mostWins.losses})`, year: book.mostWins.year });
    }
    if (book.seasonWinPct && namesMatch(book.seasonWinPct.player, playerName)) {
      out.push({ label: 'Best Season Win%', value: `${book.seasonWinPct.wins}-${book.seasonWinPct.losses} (${book.seasonWinPct.pct}%)`, year: book.seasonWinPct.year });
    }
    if (book.winStreak && namesMatch(book.winStreak.player, playerName)) {
      const span = book.winStreak.startYear === book.winStreak.endYear ? `${book.winStreak.startYear}` : `${book.winStreak.startYear}–${book.winStreak.endYear}`;
      out.push({ label: 'Longest Win Streak', value: `${book.winStreak.length} straight${book.winStreak.active ? ' (active)' : ''}`, year: span });
    }
    if (book.teamScore && namesMatch(book.teamScore.gm, playerName)) {
      out.push({ label: 'Best Single-Draft Team Score (as GM)', value: `${book.teamScore.pts} pts`, year: book.teamScore.year });
    }
    if (book.draftSteal && namesMatch(book.draftSteal.player, playerName)) {
      out.push({ label: 'Best Draft Value Pick ("Steal")', value: `+${book.draftSteal.delta} vs. window (Pick #${book.draftSteal.pick})`, year: book.draftSteal.year });
    }
    return out;
  }

  // Player-level record badges for a specific (player, year) performance —
  // for draft-history.html's roster/pick-chip rows. Excludes the team-score
  // record, which belongs to the GM row instead (see badgesForTeam).
  function badgesForPlayerYear(book, playerName, year) {
    const badges = [];
    for (const [fmt, r] of Object.entries(book.formatHighScore)) {
      if (r.year === year && namesMatch(r.player, playerName)) badges.push(`Best ${FMT_LABEL[fmt] || fmt} Score`);
    }
    for (const [day, r] of Object.entries(book.dayHighScore)) {
      if (r.year === year && namesMatch(r.player, playerName)) badges.push(`Best ${DAY_LABEL[day] || day} Score`);
    }
    if (book.seasonTotal && book.seasonTotal.year === year && namesMatch(book.seasonTotal.player, playerName)) {
      badges.push('Highest Season Total');
    }
    if (book.mostWins && book.mostWins.year === year && namesMatch(book.mostWins.player, playerName)) {
      badges.push('Most Wins (Season)');
    }
    if (book.seasonWinPct && book.seasonWinPct.year === year && namesMatch(book.seasonWinPct.player, playerName)) {
      badges.push('Best Season Win%');
    }
    if (book.winStreak && namesMatch(book.winStreak.player, playerName) && year >= book.winStreak.startYear && year <= book.winStreak.endYear) {
      badges.push(`Longest Win Streak (${book.winStreak.length}${book.winStreak.active ? ', active' : ''})`);
    }
    if (book.draftSteal && book.draftSteal.year === year && namesMatch(book.draftSteal.player, playerName)) {
      badges.push('Best Draft Value Pick');
    }
    return badges;
  }

  // GM-level record badges for a specific (gm, year) team — for
  // draft-history.html's standings row.
  function badgesForTeam(book, gmName, year) {
    const badges = [];
    if (book.teamScore && book.teamScore.year === year && namesMatch(book.teamScore.gm, gmName)) {
      badges.push('Best Single-Draft Team Score');
    }
    return badges;
  }

  global.RecordsBook = {
    compute, recordsForPlayer, badgesForPlayerYear, badgesForTeam,
    winLossDrawForPlayerYear, fullMatchSequenceForPlayer,
    FMT_MAP, FMT_LABEL, FMT_TO_DAY, DAY_LABEL, namesMatch, normName
  };
})(window);
