// Service worker. Player loading is intentionally kept very close to the
// upstream extension: fetch the live list, cache it, and fall back to the
// bundled snapshot. AI solving also lives here so a solver failure can never
// prevent the content-script UI from loading.

importScripts("solver-core.js", "probability-core.js");

const PLAYERS_URL =
  "https://firebasestorage.googleapis.com/v0/b/" +
  "project-4599904239656435772.firebasestorage.app/o/" +
  "players_flat.json?alt=media";

const CACHE_KEY = "players_cache";
const CACHE_TTL = 1000 * 60 * 60 * 12; // 12 hours

let engineData = null;

async function loadFromNetwork() {
  const res = await fetch(PLAYERS_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("players fetch failed: " + res.status);
  return res.json();
}

function loadBundled() {
  try {
    importScripts(chrome.runtime.getURL("data/players.js"));
  } catch (e) {
    // Already imported, or unavailable. Preserve upstream fallback behavior.
  }
  return Array.isArray(self.PLAYERS) ? self.PLAYERS : [];
}

async function getPlayers(forceRefresh) {
  if (!forceRefresh) {
    const cached = await chrome.storage.local.get(CACHE_KEY);
    const entry = cached[CACHE_KEY];
    if (entry && Date.now() - entry.at < CACHE_TTL && entry.data) {
      return { players: entry.data, source: "cache" };
    }
  }

  try {
    const data = await loadFromNetwork();
    await chrome.storage.local.set({ [CACHE_KEY]: { at: Date.now(), data } });
    return { players: data, source: "network" };
  } catch (err) {
    const data = loadBundled();
    return { players: data, source: "bundled", error: String(err) };
  }
}

function ensureEngine(players) {
  // getPlayers normally returns the same cached array for the life of this
  // service worker. Reinitialize only if the array object changes or reload is
  // explicitly requested.
  if (engineData !== players) {
    ProbabilityEngine.init(players);
    engineData = players;
  }
}

// ---------- first-pick odds cache ----------
//
// An empty-roster, empty-history request (the very first roll of a draft) is
// the most expensive one to solve (most future rounds, widest candidate set),
// and it is also the one most likely to recur exactly - there are only 180
// team-era pools, and the Monte Carlo sampling is already seeded
// deterministically from (roster, currentRoll, history, settings), so the
// same first-roll request always produces the same numbers. Caching it turns
// "have I seen this opening roll before" into an instant lookup instead of a
// full re-solve.
//
// Scoped deliberately narrow: only the empty-roster/empty-history case is
// cached. Every other request depends on which specific players were already
// picked, which explodes the key space for no real benefit (those states
// rarely repeat across sessions the way an opening team/era roll does).
//
// Cached in two independent parts rather than one, because they don't vary
// together: ProbabilityEngine.estimatePickActions (the expensive part - a
// beam search per candidate action per Monte Carlo scenario) never reads
// strategyMode/teamSkipAvailable/decadeSkipAvailable at all, so it is
// identical across every skip-setting combination for the same roll. Only
// estimateImmediateSkip (much cheaper - one reroll + one future sequence per
// scenario, no per-action beam search) depends on which skip is being
// evaluated. Keying everything together like a first version of this did
// would multiply the expensive half by every skip-setting combination for no
// reason - 180 team-era pools x up to ~4 skip-availability combinations.
// Splitting keeps the expensive half at a flat ~180 entries.

const FIRST_PICK_CACHE_KEY = "first_pick_odds_cache_v1";
let firstPickCache = null; // in-memory mirror: { generation, picks: {}, skips: {} }

function isFirstPick(request) {
  return !!(
    request && request.currentRoll &&
    !(request.roster && request.roster.length) &&
    !(request.history && request.history.length)
  );
}

function firstPickPicksKey(request) {
  const r = request.currentRoll;
  // Normalized to the same defaults estimatePickActions applies internally,
  // so an omitted field and its explicit default value share one cache entry.
  const simulations = request.simulations || 600;
  const beamWidth = request.beamWidth || 90;
  const candidateLimit = request.candidateLimit || 14;
  return [r.team, r.era, simulations, beamWidth, candidateLimit].join("|");
}

function firstPickSkipKey(request, kind) {
  const r = request.currentRoll;
  // Mirrors estimateImmediateSkip's own simulation-count formula. Not keyed
  // by teamSkipAvailable/decadeSkipAvailable: those flags only gate whether
  // solvePaths includes this skip in the response below, they don't change
  // what estimateImmediateSkip actually computes for a given kind.
  const simulations = Math.max(80, Math.floor((request.simulations || 600) * 0.55));
  const beamWidth = request.beamWidth || 90;
  return [r.team, r.era, simulations, beamWidth, kind].join("|");
}

async function getPlayersGeneration() {
  // Ties cache validity to the same player-data snapshot getPlayers() already
  // tracks, so a genuine data refresh invalidates stale first-pick odds
  // without any extra bookkeeping.
  const cached = await chrome.storage.local.get(CACHE_KEY);
  const entry = cached[CACHE_KEY];
  return entry ? entry.at : 0;
}

async function loadFirstPickCache() {
  if (firstPickCache) return firstPickCache;
  const stored = await chrome.storage.local.get(FIRST_PICK_CACHE_KEY);
  firstPickCache = stored[FIRST_PICK_CACHE_KEY] || { generation: 0, picks: {}, skips: {} };
  return firstPickCache;
}

function saveFirstPickCache() {
  // Fire-and-forget: never make the caller wait on the write-through.
  chrome.storage.local.set({ [FIRST_PICK_CACHE_KEY]: firstPickCache }).catch(() => {});
}

async function solvePaths(rawRequest) {
  const loaded = await getPlayers(false);
  if (!loaded.players || !loaded.players.length) {
    throw new Error("No player data available for AI solver.");
  }
  ensureEngine(loaded.players);
  const request = rawRequest || {};

  if (!isFirstPick(request)) return ProbabilityEngine.solve(request);

  const generation = await getPlayersGeneration();
  const cache = await loadFirstPickCache();
  if (cache.generation !== generation) {
    cache.generation = generation;
    cache.picks = {};
    cache.skips = {};
  }

  const pk = firstPickPicksKey(request);
  let picks = cache.picks[pk];
  if (!picks) {
    picks = ProbabilityEngine.estimatePickActions(request);
    cache.picks[pk] = picks;
  }

  const skips = [];
  if (request.strategyMode === "compare_skips") {
    ["team", "decade"].forEach(function (kind) {
      const availabilityFlag = kind === "team" ? "teamSkipAvailable" : "decadeSkipAvailable";
      if (request[availabilityFlag] === false) return;

      const sk = firstPickSkipKey(request, kind);
      let s = cache.skips[sk];
      if (!s) {
        s = ProbabilityEngine.estimateImmediateSkip(request, kind);
        if (s) cache.skips[sk] = s;
      }
      if (s) skips.push(s);
    });
    skips.sort(function (a, b) { return b.probability - a.probability; });
  }

  saveFirstPickCache();

  return {
    actions: picks.actions,
    skips: skips,
    scenarios: picks.scenarios,
    exact: picks.exact,
    model: "oracle_path",
    maxRepeat: 2
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "GET_PLAYERS") {
    getPlayers(!!msg.forceRefresh)
      .then((result) => {
        if (msg.forceRefresh) engineData = null;
        sendResponse(result);
      })
      .catch((err) => sendResponse({ players: [], error: String(err) }));
    return true;
  }

  if (msg && msg.type === "SOLVE_PATHS") {
    // Compute away from the page. The content script already renders a normal
    // OVR fallback, so errors here are non-fatal and are surfaced inline.
    solvePaths(msg.request)
      .then((result) => sendResponse({ result }))
      .catch((err) => sendResponse({ error: String(err && err.stack ? err.stack : err) }));
    return true;
  }
});

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    getPlayers, ensureEngine, solvePaths,
    isFirstPick, firstPickPicksKey, firstPickSkipKey
  };
}
