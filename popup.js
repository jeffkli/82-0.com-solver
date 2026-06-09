// Settings UI. Everything lives in chrome.storage.local under "settings"; the
// content script watches that key and re-renders when it changes, so there's
// nothing to wire up beyond reading/writing storage here. The reload button
// forces a fresh pull of the player list and nudges any open game tab to pick
// it up.

const DEFAULTS = { mode: "adjusted", skipThreshold: 85 };

const modeInputs = document.getElementsByName("mode");
const threshold = document.getElementById("threshold");
const thresholdVal = document.getElementById("thresholdVal");
const reloadBtn = document.getElementById("reload");
const status = document.getElementById("status");

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get("settings", (res) => {
      resolve(Object.assign({}, DEFAULTS, res.settings || {}));
    });
  });
}

function save(patch) {
  return getSettings().then((current) => {
    const next = Object.assign({}, current, patch);
    return new Promise((resolve) =>
      chrome.storage.local.set({ settings: next }, resolve)
    );
  });
}

function applyToUI(s) {
  Array.prototype.forEach.call(modeInputs, (r) => {
    r.checked = r.value === s.mode;
  });
  threshold.value = s.skipThreshold;
  thresholdVal.textContent = s.skipThreshold;
}

Array.prototype.forEach.call(modeInputs, (r) => {
  r.addEventListener("change", () => {
    if (r.checked) save({ mode: r.value });
  });
});

threshold.addEventListener("input", () => {
  thresholdVal.textContent = threshold.value;
});
threshold.addEventListener("change", () => {
  save({ skipThreshold: parseInt(threshold.value, 10) });
});

reloadBtn.addEventListener("click", () => {
  status.textContent = "Fetching…";
  chrome.runtime.sendMessage({ type: "GET_PLAYERS", forceRefresh: true }, (resp) => {
    if (!resp || !resp.players) {
      status.textContent = "Reload failed.";
      return;
    }
    const count = resp.players.length;
    const src = resp.source === "network" ? "live" : resp.source;
    status.textContent = "Loaded " + count + " players (" + src + ").";

    // Tell any open game tabs to re-read the freshly cached list.
    chrome.tabs.query({ url: ["https://www.82-0.com/*", "https://82-0.com/*"] }, (tabs) => {
      tabs.forEach((t) => {
        chrome.tabs.sendMessage(t.id, { type: "RELOAD_DATA" }, () => void chrome.runtime.lastError);
      });
    });
  });
});

getSettings().then(applyToUI);
