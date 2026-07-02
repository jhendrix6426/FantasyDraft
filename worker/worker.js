const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Commish-Key, X-GM-Token',
};

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

function stripTokens(gms) {
  return gms.map(({ token, ...rest }) => rest);
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
      return json(data);
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
    await env.FANTASY_DB.put('gm_registry', JSON.stringify(body));
    return json({ ok: true });
  }

  if (path === '/fantasy/gms/verify' && method === 'POST') {
    const body = await request.json();
    const gms = await env.FANTASY_DB.get('gm_registry', 'json') || [];
    const gm = gms.find(g => g.id === body.gmId);
    if (!gm || !body.token || gm.token !== body.token) return unauthorized('Invalid GM credentials');
    return json({ ok: true, id: gm.id, name: gm.name });
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
    return json(data || {
      win: 3,
      timeoutWin: 2,
      timeoutTie: 1.5,
      timeoutLoss: 1,
      loss: 0,
      rosterSize: 9,
      countPerDay: 7,
      gradeWeights: { nationals: 0.5, rnrsCurrent: 0.3, rnrsHistory: 0.2 },
      formatCeilings: { T1: 1.0, T2: 1.0, BD: 0.85, SD: 0.80, Teams: 0.80, TA: 0.65 }
    });
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
    if (!state.picks.length) return conflict('No picks to undo');
    state.picks.pop();
    if (state.status === 'complete') state.status = 'active';
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
