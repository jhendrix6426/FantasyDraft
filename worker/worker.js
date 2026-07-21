const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Commish-Key, X-GM-Token, X-Scorekeeper-Key',
};

const DEFAULT_SCORING_CONFIG = {
  win: 3,
  timeoutWin: 2,
  timeoutTie: 1.5,
  timeoutLoss: 1,
  loss: 0,
  rosterSize: 9,
  countPerDay: 7,
  gradeWeights: { nationals: 0.5, rnrsCurrent: 0.3, rnrsHistory: 0.2 },
  formatCeilings: { T1: 1.0, T2: 1.0, BD: 0.85, SD: 0.80, Teams: 0.80, TA: 0.65 }
};

const VALID_DAYS = ['thu', 'fri', 'sat'];
const VALID_RESULTS = ['win', 'timeoutWin', 'timeoutTie', 'timeoutLoss', 'loss'];

// Short format code (as stored on players_<year> entries) -> verbose format
// name (as used in scouting.html/records.js's FMT_MAP and in the
// tournaments[].fantasyDraft breakdown[].format field on nationals-history).
const FMT_CODE_TO_NAME = { T1: 'T1 2-Player', T2: 'T2 2-Player', BD: 'Booster Draft', SD: 'Sealed', Teams: 'Teams', TA: 'Type A' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function notFound(msg) { return json({ error: msg || 'Not found' }, 404); }
function badRequest(msg) { return json({ error: msg || 'Bad request' }, 400); }
function unauthorized(msg) { return json({ error: msg || 'Unauthorized' }, 401); }
function forbidden(msg) { return json({ error: msg || 'Forbidden' }, 403); }
function conflict(msg) { return json({ error: msg || 'Conflict' }, 409); }

function requireCommish(request, env) {
  const key = request.headers.get('X-Commish-Key');
  return !!key && !!env.COMMISH_KEY && key === env.COMMISH_KEY;
}

function requireScorekeeper(request, env) {
  const key = request.headers.get('X-Scorekeeper-Key');
  return !!key && !!env.SCOREKEEPER_KEY && key === env.SCOREKEEPER_KEY;
}

function stripTokens(gms) {
  return gms.map(({ token, username, passwordHash, passwordSalt, ...rest }) => rest);
}

function r1(n) { return Math.round(n * 10) / 10; }

// ── Password hashing (PBKDF2 via Workers' built-in Web Crypto — no external
// dependency, keeps worker.js a single dependency-free file) ────────────────
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
async function verifyPassword(password, salt, hash) {
  return (await hashPassword(password, salt)) === hash;
}
// word-word-number — easy to read aloud or paste into a text message when a
// commissioner relays a reset password, unlike a random opaque string.
const PASSWORD_WORDS = ['swift','tiger','coral','amber','delta','vivid','maple','quartz','nomad','ember','pixel','raven','solar','cobalt','fable','comet','harbor','willow','ridge','onyx'];
function generatePassword() {
  const w1 = PASSWORD_WORDS[Math.floor(Math.random() * PASSWORD_WORDS.length)];
  const w2 = PASSWORD_WORDS[Math.floor(Math.random() * PASSWORD_WORDS.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${w1}-${w2}-${num}`;
}

// Snake-draft turn order, derived entirely from picks already made — never
// persisted, so it can't desync from the picks array that's the source of truth.
function computeTurn(draftOrder, picks, rosterSize) {
  const n = draftOrder.length;
  const total = n * rosterSize;
  const pickIndex = picks.length; // 0-based index of the NEXT pick
  const isComplete = n === 0 || rosterSize <= 0 || pickIndex >= total;

  const slotGm = (idx) => {
    const round = Math.floor(idx / n) + 1;
    const posInRound = idx % n;
    const gmIndex = (round % 2 === 1) ? posInRound : (n - 1 - posInRound);
    return { round, gm: draftOrder[gmIndex] };
  };

  if (isComplete) {
    return { round: null, pickNumber: pickIndex, onTheClock: null, isComplete: true, onDeck: [] };
  }

  const { round, gm: onTheClock } = slotGm(pickIndex);
  const onDeck = [];
  for (let i = 1; i <= 3 && pickIndex + i < total; i++) {
    onDeck.push(slotGm(pickIndex + i).gm);
  }

  return { round, pickNumber: pickIndex + 1, onTheClock, isComplete: false, onDeck };
}

function defaultLivescore() {
  return {
    thu: { status: 'active', entries: [] },
    fri: { status: 'active', entries: [] },
    sat: { status: 'active', entries: [] },
  };
}

// Rolls up raw per-round entries into team day/season totals: each team's
// daily score counts only its top `countPerDay` rostered players that day
// (roster members with no entries that day count as 0, same as a bad
// performance — this is deliberate, see CLAUDE.md for the rationale).
async function computeLivescoreState(env, year) {
  const [livescore, livedraft, players, config] = await Promise.all([
    env.FANTASY_DB.get('livescore_' + year, 'json'),
    env.FANTASY_DB.get('livedraft_' + year, 'json'),
    env.FANTASY_DB.get('players_' + year, 'json'),
    env.FANTASY_DB.get('scoring_config', 'json'),
  ]);
  const days = livescore || defaultLivescore();
  const picks = (livedraft && livedraft.picks) || [];
  const playerList = players || [];
  const countPerDay = (config || DEFAULT_SCORING_CONFIG).countPerDay || DEFAULT_SCORING_CONFIG.countPerDay;

  const rosterByGm = {};
  for (const pick of picks) {
    (rosterByGm[pick.gm] = rosterByGm[pick.gm] || []).push(pick.player);
  }
  const playerInfo = {};
  for (const p of playerList) playerInfo[p.name] = p;

  const teams = Object.entries(rosterByGm).map(([gm, rosterNames]) => {
    const roster = rosterNames.map(name => ({
      name,
      thu: (playerInfo[name] && playerInfo[name].thu) || null,
      fri: (playerInfo[name] && playerInfo[name].fri) || null,
      sat: (playerInfo[name] && playerInfo[name].sat) || null,
    }));
    const dayTotals = {};
    let seasonTotal = 0;
    for (const day of VALID_DAYS) {
      const dayEntries = (days[day] && days[day].entries) || [];
      const totalsByPlayer = {};
      for (const e of dayEntries) totalsByPlayer[e.player] = (totalsByPlayer[e.player] || 0) + e.pts;
      const scores = rosterNames.map(name => totalsByPlayer[name] || 0).sort((a, b) => b - a);
      const dayTotal = r1(scores.slice(0, countPerDay).reduce((s, v) => s + v, 0));
      dayTotals[day] = dayTotal;
      seasonTotal += dayTotal;
    }
    return { gm, roster, dayTotals, seasonTotal: r1(seasonTotal) };
  });

  return { year: Number(year), days, teams };
}

// Builds the same `tournaments[].fantasyDraft` shape records.js/draft-history.html/
// scouting.html already expect from nationals-history's hardcoded historical
// years, but derived live from this Worker's own data — roster + draftPick
// from livedraft_<year>.picks, gm display name from gm_registry, and each
// player's per-format point breakdown summed from livescore_<year> entries.
// Only ever called for a finalized draft (see GET .../history below) — a
// draft's roster/scores only become "history" once the commissioner has
// locked them in.
async function computeFantasyDraftHistory(env, year) {
  const [livedraft, gmRegistry, livescore, players, config] = await Promise.all([
    env.FANTASY_DB.get('livedraft_' + year, 'json'),
    env.FANTASY_DB.get('gm_registry', 'json'),
    env.FANTASY_DB.get('livescore_' + year, 'json'),
    env.FANTASY_DB.get('players_' + year, 'json'),
    env.FANTASY_DB.get('scoring_config', 'json'),
  ]);
  if (!livedraft || !livedraft.finalized) return null;

  const gmName = {};
  for (const g of (gmRegistry || [])) gmName[g.id] = g.name;

  const days = livescore || defaultLivescore();
  const playerInfo = {};
  for (const p of (players || [])) playerInfo[p.name] = p;
  const countPerDay = (config || DEFAULT_SCORING_CONFIG).countPerDay || DEFAULT_SCORING_CONFIG.countPerDay;

  // Per-player, per-day point totals — same additive-within-a-day summing as
  // computeLivescoreState (worker.js above), just kept at player granularity
  // instead of collapsed straight into a team total.
  const dayTotalsByPlayer = {};
  for (const day of VALID_DAYS) {
    const entries = (days[day] && days[day].entries) || [];
    for (const e of entries) {
      dayTotalsByPlayer[e.player] = dayTotalsByPlayer[e.player] || {};
      dayTotalsByPlayer[e.player][day] = (dayTotalsByPlayer[e.player][day] || 0) + e.pts;
    }
  }

  const rosterByGm = {};
  for (const pick of (livedraft.picks || [])) {
    (rosterByGm[pick.gm] = rosterByGm[pick.gm] || []).push(pick);
  }

  const teams = Object.entries(rosterByGm).map(([gmId, gmPicks]) => {
    const rosterNames = gmPicks.map(p => p.player);

    // Team pts uses the same top-countPerDay-of-roster-per-day rule as
    // computeLivescoreState, so this matches what live-scoring already shows.
    let seasonTotal = 0;
    for (const day of VALID_DAYS) {
      const scores = rosterNames
        .map(name => (dayTotalsByPlayer[name] && dayTotalsByPlayer[name][day]) || 0)
        .sort((a, b) => b - a);
      seasonTotal += scores.slice(0, countPerDay).reduce((s, v) => s + v, 0);
    }

    const teamPlayers = gmPicks.map(pick => {
      const name = pick.player;
      const info = playerInfo[name] || {};
      const breakdown = [];
      let pts = 0;
      for (const day of VALID_DAYS) {
        const fmtCode = info[day];
        if (!fmtCode) continue; // not registered to play this day
        const dayPts = (dayTotalsByPlayer[name] && dayTotalsByPlayer[name][day]) || 0;
        const verbose = FMT_CODE_TO_NAME[fmtCode];
        if (verbose) breakdown.push({ format: verbose, pts: r1(dayPts) });
        pts += dayPts;
      }
      return { name, pts: r1(pts), draftPick: pick.pickNumber, breakdown };
    });

    return { gm: gmName[gmId] || gmId, pts: r1(seasonTotal), players: teamPlayers };
  });

  return { year: Number(year), finalized: true, teams };
}

async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '');
  const method = request.method;
  const parts = path.split('/'); // ['', 'fantasy', <resource>, <year>, <action>]

  if (path === '/fantasy/ping') {
    return json({ ok: true, ts: Date.now() });
  }

  if (path === '/fantasy/all' && method === 'GET') {
    const [drafts, gms, config] = await Promise.all([
      env.FANTASY_DB.get('drafts', 'json'),
      env.FANTASY_DB.get('gm_registry', 'json'),
      env.FANTASY_DB.get('scoring_config', 'json'),
    ]);
    return json({ drafts: drafts || {}, gms: stripTokens(gms || []), config: config || {} });
  }

  if (path === '/fantasy/drafts' && method === 'GET') {
    const data = await env.FANTASY_DB.get('drafts', 'json');
    return json(data || {});
  }

  if (path.startsWith('/fantasy/drafts/') && method === 'GET') {
    const year = parts[3];
    const data = await env.FANTASY_DB.get('drafts', 'json') || {};
    if (!data[year]) return notFound('No draft data for ' + year);
    return json(data[year]);
  }

  if (path.startsWith('/fantasy/drafts/') && method === 'PUT') {
    if (!requireCommish(request, env)) return unauthorized();
    const year = parts[3];
    const body = await request.json();
    const data = await env.FANTASY_DB.get('drafts', 'json') || {};
    data[year] = body;
    await env.FANTASY_DB.put('drafts', JSON.stringify(data));
    return json({ ok: true, year });
  }

  // Public GM list (name/id only). Commissioner tooling that needs to edit the
  // roster without wiping everyone else's token must use ?full=1 (auth'd) instead.
  if (path === '/fantasy/gms' && method === 'GET') {
    const data = await env.FANTASY_DB.get('gm_registry', 'json') || [];
    if (url.searchParams.get('full') === '1') {
      if (!requireCommish(request, env)) return unauthorized();
      // Password hashes never leave the Worker, even to commissioner tooling —
      // the roster editor only needs to know whether one is set.
      return json(data.map(({ passwordHash, passwordSalt, ...rest }) => ({ ...rest, hasPassword: !!passwordHash })));
    }
    return json(stripTokens(data));
  }

  if (path === '/fantasy/gms' && method === 'PUT') {
    if (!requireCommish(request, env)) return unauthorized();
    const body = await request.json();
    if (!Array.isArray(body)) return badRequest('Body must be an array of GMs');
    for (const gm of body) {
      if (!gm.id || !gm.name || !gm.token) return badRequest('Every GM needs id, name, and token');
    }
    // The roster editor never sees password hashes (see GET above), so it can
    // never round-trip them — preserve each GM's existing passwordHash/Salt
    // by id here rather than letting a routine roster save silently wipe it.
    const existing = await env.FANTASY_DB.get('gm_registry', 'json') || [];
    const existingById = {};
    for (const g of existing) existingById[g.id] = g;
    const merged = body.map(gm => {
      const prev = existingById[gm.id] || {};
      return {
        id: gm.id, name: gm.name, token: gm.token, active: gm.active !== false,
        username: gm.username !== undefined ? gm.username : prev.username,
        passwordHash: prev.passwordHash, passwordSalt: prev.passwordSalt,
      };
    });
    await env.FANTASY_DB.put('gm_registry', JSON.stringify(merged));
    return json({ ok: true });
  }

  if (path === '/fantasy/gms/verify' && method === 'POST') {
    const body = await request.json();
    const gms = await env.FANTASY_DB.get('gm_registry', 'json') || [];
    const gm = gms.find(g => g.id === body.gmId);
    if (!gm || !body.token || gm.token !== body.token) return unauthorized('Invalid GM credentials');
    return json({ ok: true, id: gm.id, name: gm.name });
  }

  // Username+password is an alternate front door onto the exact same session
  // token the shareable-link flow already uses — every other GM-authenticated
  // endpoint still just checks X-GM-Token, unchanged.
  if (path === '/fantasy/gms/login' && method === 'POST') {
    const body = await request.json();
    const { username, password } = body;
    if (!username || !password) return badRequest('username and password are required');
    const gms = await env.FANTASY_DB.get('gm_registry', 'json') || [];
    const gm = gms.find(g => g.username && g.username.toLowerCase() === String(username).toLowerCase());
    if (!gm || !gm.passwordHash || !(await verifyPassword(password, gm.passwordSalt, gm.passwordHash))) {
      return unauthorized('Invalid username or password');
    }
    return json({ ok: true, id: gm.id, name: gm.name, token: gm.token });
  }

  // Commissioner-only recovery path — no email sending required. Generates
  // and returns a new password once; the commissioner relays it out of band.
  if (path === '/fantasy/gms/reset-password' && method === 'POST') {
    if (!requireCommish(request, env)) return unauthorized();
    const body = await request.json();
    const { gmId } = body;
    if (!gmId) return badRequest('gmId is required');
    const gms = await env.FANTASY_DB.get('gm_registry', 'json') || [];
    const gm = gms.find(g => g.id === gmId);
    if (!gm) return notFound('No GM with id ' + gmId);
    const newPassword = generatePassword();
    gm.passwordSalt = crypto.randomUUID();
    gm.passwordHash = await hashPassword(newPassword, gm.passwordSalt);
    await env.FANTASY_DB.put('gm_registry', JSON.stringify(gms));
    return json({ ok: true, newPassword });
  }

  // GM self-service — requires knowing the current password (whatever the
  // commissioner's last reset issued), not just an active token/session, so
  // someone at an unlocked device can't silently take over the account.
  if (path === '/fantasy/gms/change-password' && method === 'POST') {
    const gmToken = request.headers.get('X-GM-Token');
    const body = await request.json();
    const { gmId, currentPassword, newPassword } = body;
    if (!gmId || !currentPassword || !newPassword) return badRequest('gmId, currentPassword, and newPassword are required');
    if (newPassword.length < 6) return badRequest('New password must be at least 6 characters');
    const gms = await env.FANTASY_DB.get('gm_registry', 'json') || [];
    const gm = gms.find(g => g.id === gmId);
    if (!gm || !gmToken || gm.token !== gmToken) return unauthorized('Invalid GM credentials');
    if (!gm.passwordHash || !(await verifyPassword(currentPassword, gm.passwordSalt, gm.passwordHash))) {
      return unauthorized('Current password is incorrect');
    }
    gm.passwordSalt = crypto.randomUUID();
    gm.passwordHash = await hashPassword(newPassword, gm.passwordSalt);
    await env.FANTASY_DB.put('gm_registry', JSON.stringify(gms));
    return json({ ok: true });
  }

  if (path.startsWith('/fantasy/results/') && method === 'GET') {
    const year = parts[3];
    const data = await env.FANTASY_DB.get('results_' + year, 'json');
    return json(data || {});
  }

  if (path.startsWith('/fantasy/results/') && method === 'PUT') {
    if (!requireCommish(request, env)) return unauthorized();
    const year = parts[3];
    const body = await request.json();
    await env.FANTASY_DB.put('results_' + year, JSON.stringify(body));
    return json({ ok: true, year });
  }

  if (path.startsWith('/fantasy/scouting/') && method === 'GET') {
    const year = parts[3];
    const data = await env.FANTASY_DB.get('scouting_' + year, 'json');
    return json(data || {});
  }

  if (path.startsWith('/fantasy/scouting/') && method === 'PUT') {
    if (!requireCommish(request, env)) return unauthorized();
    const year = parts[3];
    const body = await request.json();
    await env.FANTASY_DB.put('scouting_' + year, JSON.stringify(body));
    return json({ ok: true, year });
  }

  if (path === '/fantasy/config' && method === 'GET') {
    const data = await env.FANTASY_DB.get('scoring_config', 'json');
    return json(data || DEFAULT_SCORING_CONFIG);
  }

  if (path === '/fantasy/config' && method === 'PUT') {
    if (!requireCommish(request, env)) return unauthorized();
    const body = await request.json();
    await env.FANTASY_DB.put('scoring_config', JSON.stringify(body));
    return json({ ok: true });
  }

  if (path.startsWith('/fantasy/players/') && method === 'GET') {
    const year = parts[3];
    const data = await env.FANTASY_DB.get('players_' + year, 'json');
    return json(data || []);
  }

  if (path.startsWith('/fantasy/players/') && method === 'PUT') {
    if (!requireCommish(request, env)) return unauthorized();
    const year = parts[3];
    const body = await request.json();
    await env.FANTASY_DB.put('players_' + year, JSON.stringify(body));
    return json({ ok: true, year, count: body.length });
  }

  // ── Live draft ──────────────────────────────────────────────
  const defaultLivedraft = (year) => ({
    status: 'pre', year: Number(year), draftOrder: [], rosterSize: 0, playerPool: [], picks: [],
  });

  if (path.startsWith('/fantasy/livedraft/') && method === 'GET' && parts.length === 4) {
    const year = parts[3];
    const state = await env.FANTASY_DB.get('livedraft_' + year, 'json') || defaultLivedraft(year);
    const turn = computeTurn(state.draftOrder || [], state.picks || [], state.rosterSize || 0);
    return json({ ...state, ...turn });
  }

  // Raw overwrite, kept only for manual commissioner recovery — prefer the
  // start/pause/resume/undo/pick actions below for normal operation.
  if (path.startsWith('/fantasy/livedraft/') && method === 'PUT' && parts.length === 4) {
    if (!requireCommish(request, env)) return unauthorized();
    const year = parts[3];
    const existing = await env.FANTASY_DB.get('livedraft_' + year, 'json');
    if (existing && existing.finalized) return conflict('Draft is finalized and cannot be modified');
    const body = await request.json();
    body.updatedAt = Date.now();
    await env.FANTASY_DB.put('livedraft_' + year, JSON.stringify(body));
    return json({ ok: true, year });
  }

  if (path.endsWith('/start') && path.startsWith('/fantasy/livedraft/') && method === 'POST') {
    if (!requireCommish(request, env)) return unauthorized();
    const year = parts[3];
    const body = await request.json();
    const { draftOrder, rosterSize, playerPoolYear } = body;
    if (!Array.isArray(draftOrder) || draftOrder.length === 0) return badRequest('draftOrder must be a non-empty array of GM ids');
    if (!Number.isInteger(rosterSize) || rosterSize <= 0) return badRequest('rosterSize must be a positive integer');
    const pool = await env.FANTASY_DB.get('players_' + (playerPoolYear || year), 'json') || [];
    const state = {
      status: 'active',
      year: Number(year),
      draftOrder,
      rosterSize,
      playerPool: pool,
      picks: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await env.FANTASY_DB.put('livedraft_' + year, JSON.stringify(state));
    return json({ ok: true, ...state, ...computeTurn(draftOrder, [], rosterSize) });
  }

  if ((path.endsWith('/pause') || path.endsWith('/resume')) && path.startsWith('/fantasy/livedraft/') && method === 'POST') {
    if (!requireCommish(request, env)) return unauthorized();
    const year = parts[3];
    const action = parts[4];
    const state = await env.FANTASY_DB.get('livedraft_' + year, 'json');
    if (!state) return notFound('No draft for ' + year);
    if (action === 'pause') {
      if (state.status !== 'active') return conflict('Draft is not active');
      state.status = 'paused';
    } else {
      if (state.status !== 'paused') return conflict('Draft is not paused');
      state.status = 'active';
    }
    state.updatedAt = Date.now();
    await env.FANTASY_DB.put('livedraft_' + year, JSON.stringify(state));
    return json({ ok: true, ...state, ...computeTurn(state.draftOrder, state.picks, state.rosterSize) });
  }

  if (path.endsWith('/undo') && path.startsWith('/fantasy/livedraft/') && method === 'POST') {
    if (!requireCommish(request, env)) return unauthorized();
    const year = parts[3];
    const state = await env.FANTASY_DB.get('livedraft_' + year, 'json');
    if (!state) return notFound('No draft for ' + year);
    if (state.finalized) return conflict('Draft is finalized and cannot be undone');
    if (!state.picks.length) return conflict('No picks to undo');
    state.picks.pop();
    if (state.status === 'complete') state.status = 'active';
    state.updatedAt = Date.now();
    await env.FANTASY_DB.put('livedraft_' + year, JSON.stringify(state));
    return json({ ok: true, ...state, ...computeTurn(state.draftOrder, state.picks, state.rosterSize) });
  }

  // Full hard reset back to pre-draft — for rehearsing a draft on the real
  // year and then clearing it before the actual event. Only touches
  // livedraft_<year> (draft order/roster size/pool/picks); GM roster/tokens
  // and each GM's private board (board_<year>_<gmId>) are untouched, so a
  // rehearsal's board work carries forward into the real draft.
  if (path.endsWith('/reset') && path.startsWith('/fantasy/livedraft/') && method === 'POST') {
    if (!requireCommish(request, env)) return unauthorized();
    const year = parts[3];
    const existing = await env.FANTASY_DB.get('livedraft_' + year, 'json');
    if (existing && existing.finalized) return conflict('Draft is finalized and cannot be reset');
    const state = defaultLivedraft(year);
    await env.FANTASY_DB.put('livedraft_' + year, JSON.stringify(state));
    return json({ ok: true, ...state, ...computeTurn([], [], 0) });
  }

  // Permanent lock, taken once a draft is complete (before any scoring
  // happens) — no /unfinalize exists on purpose. A real post-event mistake
  // is fixed via a manual KV edit outside the app, deliberately, not an
  // in-app undo. Also gates GET .../history below (see Part B): a draft's
  // roster only surfaces as history once the commissioner has locked it in.
  if (path.endsWith('/finalize') && path.startsWith('/fantasy/livedraft/') && method === 'POST') {
    if (!requireCommish(request, env)) return unauthorized();
    const year = parts[3];
    const state = await env.FANTASY_DB.get('livedraft_' + year, 'json');
    if (!state) return notFound('No draft for ' + year);
    if (state.finalized) return conflict('Draft is already finalized');
    const turn = computeTurn(state.draftOrder || [], state.picks || [], state.rosterSize || 0);
    if (!turn.isComplete) return conflict('Draft is not complete');
    state.finalized = true;
    state.finalizedAt = Date.now();
    state.updatedAt = Date.now();
    await env.FANTASY_DB.put('livedraft_' + year, JSON.stringify(state));
    return json({ ok: true, ...state, ...computeTurn(state.draftOrder, state.picks, state.rosterSize) });
  }

  if (path.endsWith('/pick') && path.startsWith('/fantasy/livedraft/') && method === 'POST') {
    const year = parts[3];
    const gmToken = request.headers.get('X-GM-Token');
    const body = await request.json();
    const { gmId, player, pickRequestId } = body;
    if (!gmId || !player || !pickRequestId) return badRequest('gmId, player, and pickRequestId are required');

    const gms = await env.FANTASY_DB.get('gm_registry', 'json') || [];
    const gm = gms.find(g => g.id === gmId);
    if (!gm || !gmToken || gm.token !== gmToken) return unauthorized('Invalid GM credentials');

    const state = await env.FANTASY_DB.get('livedraft_' + year, 'json');
    if (!state) return notFound('No draft for ' + year);
    if (state.finalized) return conflict('Draft is finalized');
    if (state.status !== 'active') return conflict('Draft is not active (status: ' + state.status + ')');

    // Idempotent replay: a retried/double-submitted request for a pick that
    // already landed returns the same result instead of erroring.
    const existing = state.picks.find(p => p.pickRequestId === pickRequestId);
    if (existing) {
      return json({ ok: true, replay: true, pick: existing, ...state, ...computeTurn(state.draftOrder, state.picks, state.rosterSize) });
    }

    const turn = computeTurn(state.draftOrder, state.picks, state.rosterSize);
    if (turn.isComplete) return conflict('Draft is already complete');
    if (turn.onTheClock !== gmId) return forbidden('Not your turn (on the clock: ' + turn.onTheClock + ')');

    const inPool = state.playerPool.some(p => p.name === player);
    if (!inPool) return badRequest('Player not in pool: ' + player);
    const alreadyPicked = state.picks.some(p => p.player === player);
    if (alreadyPicked) return badRequest('Player already drafted: ' + player);

    const pick = { pickNumber: turn.pickNumber, round: turn.round, gm: gmId, player, ts: Date.now(), pickRequestId };
    state.picks.push(pick);
    const newTurn = computeTurn(state.draftOrder, state.picks, state.rosterSize);
    state.status = newTurn.isComplete ? 'complete' : 'active';
    state.updatedAt = Date.now();
    await env.FANTASY_DB.put('livedraft_' + year, JSON.stringify(state));
    return json({ ok: true, pick, ...state, ...newTurn });
  }

  // Public, computed roster+score history for a finalized draft — the
  // fantasyDraft-shaped payload draft-history.html/records.js/scouting.html
  // consume, sourced live from this Worker instead of a manual transcription
  // into the separate nationals-history API. 409s until /finalize has run.
  if (path.endsWith('/history') && path.startsWith('/fantasy/livedraft/') && method === 'GET') {
    const year = parts[3];
    const history = await computeFantasyDraftHistory(env, year);
    if (!history) return conflict('Draft is not finalized');
    return json(history);
  }

  // ── GM draft boards ─────────────────────────────────────────
  // A GM's private, pre-ranked wishlist for a draft — never exposed via the
  // public /fantasy/livedraft/:year response (that's read by every GM and the
  // broadcast view), only fetchable by that GM's own token. Usable before the
  // draft starts (so a GM can build it ahead of time) and during it.
  if (path.endsWith('/board') && path.startsWith('/fantasy/livedraft/') && method === 'GET') {
    const year = parts[3];
    const gmId = url.searchParams.get('gmId');
    const gmToken = request.headers.get('X-GM-Token');
    if (!gmId) return badRequest('gmId query param is required');
    const gms = await env.FANTASY_DB.get('gm_registry', 'json') || [];
    const gm = gms.find(g => g.id === gmId);
    if (!gm || !gmToken || gm.token !== gmToken) return unauthorized('Invalid GM credentials');
    const board = await env.FANTASY_DB.get(`board_${year}_${gmId}`, 'json') || [];
    return json({ ok: true, board });
  }

  if (path.endsWith('/board') && path.startsWith('/fantasy/livedraft/') && method === 'PUT') {
    const year = parts[3];
    const gmToken = request.headers.get('X-GM-Token');
    const body = await request.json();
    const { gmId, board } = body;
    if (!gmId || !Array.isArray(board) || !board.every(n => typeof n === 'string')) {
      return badRequest('gmId and board (array of player names) are required');
    }
    const gms = await env.FANTASY_DB.get('gm_registry', 'json') || [];
    const gm = gms.find(g => g.id === gmId);
    if (!gm || !gmToken || gm.token !== gmToken) return unauthorized('Invalid GM credentials');
    await env.FANTASY_DB.put(`board_${year}_${gmId}`, JSON.stringify(board));
    return json({ ok: true, board });
  }

  // ── Live scoring ────────────────────────────────────────────
  // Rosters come from livedraft_<year>'s completed picks (grouped by gm) —
  // this feature assumes the year's draft was run through /fantasy/livedraft,
  // not a separately-defined roster.
  if (path.startsWith('/fantasy/livescore/') && method === 'GET' && parts.length === 4) {
    const year = parts[3];
    return json(await computeLivescoreState(env, year));
  }

  if (path.endsWith('/entry') && path.startsWith('/fantasy/livescore/') && method === 'POST') {
    if (!requireScorekeeper(request, env)) return unauthorized();
    const year = parts[3];
    const body = await request.json();
    const { day, player, result } = body;
    if (!VALID_DAYS.includes(day)) return badRequest('day must be one of: ' + VALID_DAYS.join(', '));
    if (!VALID_RESULTS.includes(result)) return badRequest('result must be one of: ' + VALID_RESULTS.join(', '));
    if (!player) return badRequest('player is required');

    const config = await env.FANTASY_DB.get('scoring_config', 'json') || DEFAULT_SCORING_CONFIG;
    const pts = config[result];
    if (typeof pts !== 'number') return badRequest('No point value configured for result: ' + result);

    const livescore = await env.FANTASY_DB.get('livescore_' + year, 'json') || defaultLivescore();
    if (!livescore[day]) livescore[day] = { status: 'active', entries: [] };
    if (livescore[day].status === 'final') return conflict('That day is already finalized — unfinalize it first to add more entries');

    const entry = { id: crypto.randomUUID(), player, result, pts, ts: Date.now() };
    livescore[day].entries.push(entry);
    await env.FANTASY_DB.put('livescore_' + year, JSON.stringify(livescore));
    return json({ ok: true, entry, ...(await computeLivescoreState(env, year)) });
  }

  if (path.startsWith('/fantasy/livescore/') && parts[4] === 'entry' && parts[5] && method === 'DELETE') {
    if (!requireScorekeeper(request, env)) return unauthorized();
    const year = parts[3];
    const entryId = parts[5];
    const livescore = await env.FANTASY_DB.get('livescore_' + year, 'json') || defaultLivescore();
    let found = false;
    for (const day of VALID_DAYS) {
      if (!livescore[day]) continue;
      const before = livescore[day].entries.length;
      livescore[day].entries = livescore[day].entries.filter(e => e.id !== entryId);
      if (livescore[day].entries.length !== before) found = true;
    }
    if (!found) return notFound('Entry not found: ' + entryId);
    await env.FANTASY_DB.put('livescore_' + year, JSON.stringify(livescore));
    return json({ ok: true, ...(await computeLivescoreState(env, year)) });
  }

  if ((path.endsWith('/finalize') || path.endsWith('/unfinalize')) && path.startsWith('/fantasy/livescore/') && method === 'POST') {
    if (!requireScorekeeper(request, env)) return unauthorized();
    const year = parts[3];
    const day = parts[4];
    const action = parts[5];
    if (!VALID_DAYS.includes(day)) return badRequest('day must be one of: ' + VALID_DAYS.join(', '));

    const livescore = await env.FANTASY_DB.get('livescore_' + year, 'json') || defaultLivescore();
    if (!livescore[day]) livescore[day] = { status: 'active', entries: [] };
    if (action === 'finalize') {
      if (livescore[day].status === 'final') return conflict('Day is already finalized');
      livescore[day].status = 'final';
      livescore[day].finalizedAt = Date.now();
    } else {
      if (livescore[day].status !== 'final') return conflict('Day is not finalized');
      livescore[day].status = 'active';
      livescore[day].finalizedAt = null;
    }
    await env.FANTASY_DB.put('livescore_' + year, JSON.stringify(livescore));
    return json({ ok: true, ...(await computeLivescoreState(env, year)) });
  }

  return notFound('Unknown endpoint');
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  },
};
