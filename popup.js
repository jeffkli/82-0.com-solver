const DEFAULTS = {
  strategyMode: "no_skips",
  simulations: 200,
  teamSkipAvailable: true,
  decadeSkipAvailable: true
};

const strategyInputs = document.getElementsByName("strategyMode");
const simulations = document.getElementById("simulations");
const simulationsVal = document.getElementById("simulationsVal");
const teamSkip = document.getElementById("teamSkipAvailable");
const decadeSkip = document.getElementById("decadeSkipAvailable");
const skipOptions = document.getElementById("skipOptions");
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
    return new Promise((resolve) => chrome.storage.local.set({ settings: next }, resolve));
  });
}

function selectedStrategy() {
  let out = DEFAULTS.strategyMode;
  Array.prototype.forEach.call(strategyInputs, (r) => {
    if (r.checked) out = r.value;
  });
  return out;
}

function updateSkipVisibility() {
  skipOptions.style.display = selectedStrategy() === "compare_skips" ? "block" : "none";
}

function applyToUI(s) {
  Array.prototype.forEach.call(strategyInputs, (r) => {
    r.checked = r.value === s.strategyMode;
  });
  simulations.value = s.simulations;
  simulationsVal.textContent = s.simulations;
  teamSkip.checked = s.teamSkipAvailable !== false;
  decadeSkip.checked = s.decadeSkipAvailable !== false;
  updateSkipVisibility();
}

Array.prototype.forEach.call(strategyInputs, (r) => {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    updateSkipVisibility();
    save({ strategyMode: r.value });
  });
});

simulations.addEventListener("input", () => {
  simulationsVal.textContent = simulations.value;
});
simulations.addEventListener("change", () => {
  save({ simulations: parseInt(simulations.value, 10) });
});
teamSkip.addEventListener("change", () => save({ teamSkipAvailable: teamSkip.checked }));
decadeSkip.addEventListener("change", () => save({ decadeSkipAvailable: decadeSkip.checked }));

reloadBtn.addEventListener("click", () => {
  status.textContent = "Fetching…";
  chrome.runtime.sendMessage({ type: "GET_PLAYERS", forceRefresh: true }, (resp) => {
    if (!resp || !resp.players) {
      status.textContent = "Reload failed.";
      return;
    }
    const src = resp.source === "network" ? "live" : resp.source;
    status.textContent = "Loaded " + resp.players.length + " players (" + src + ").";
    chrome.tabs.query({ url: ["https://www.82-0.com/*", "https://82-0.com/*"] }, (tabs) => {
      tabs.forEach((t) => {
        chrome.tabs.sendMessage(t.id, { type: "RELOAD_DATA" }, () => void chrome.runtime.lastError);
      });
    });
  });
});

getSettings().then(applyToUI);
