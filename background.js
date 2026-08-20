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

async function solvePaths(request) {
  const loaded = await getPlayers(false);
  if (!loaded.players || !loaded.players.length) {
    throw new Error("No player data available for AI solver.");
  }
  ensureEngine(loaded.players);
  return ProbabilityEngine.solve(request || {});
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
  module.exports = { getPlayers, ensureEngine, solvePaths };
}
