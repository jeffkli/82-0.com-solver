// Service worker. Its main job is pulling the player list from Firebase and
// caching it so the content script doesn't have to deal with cross-origin
// fetches itself. Falls back to the bundled placeholder if the network call
// fails for any reason.

const PLAYERS_URL =
  "https://firebasestorage.googleapis.com/v0/b/" +
  "project-4599904239656435772.firebasestorage.app/o/" +
  "players_flat.json?alt=media";

const CACHE_KEY = "players_cache";
const CACHE_TTL = 1000 * 60 * 60 * 12; // 12 hours

async function loadFromNetwork() {
  const res = await fetch(PLAYERS_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("players fetch failed: " + res.status);
  return res.json();
}

function loadBundled() {
  // data/players.js sets self.PLAYERS when imported into the worker.
  try {
    importScripts(chrome.runtime.getURL("data/players.js"));
  } catch (e) {
    // already imported, or unavailable
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
    const data = await loadBundled();
    return { players: data, source: "bundled", error: String(err) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "GET_PLAYERS") {
    getPlayers(msg.forceRefresh)
      .then(sendResponse)
      .catch((err) => sendResponse({ players: [], error: String(err) }));
    return true; // keep the channel open for the async reply
  }
});
