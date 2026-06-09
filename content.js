/*
 * Runs on 82-0.com. Reads whatever team/era is currently rolled out of the
 * page, looks up the matching player pool, and shows the picks that move the
 * team OVR the most. The site is a Next.js app that swaps content in place, so
 * we watch the DOM with a MutationObserver instead of relying on page loads.
 *
 * The page markup isn't documented anywhere, so roll detection works by
 * scanning visible text for a decade token (e.g. "1990s") and a team name we
 * recognize from the player data. If the site ever exposes cleaner hooks,
 * drop the selectors into CONFIG.rollSelector and we'll use those first.
 */

(function () {
  "use strict";

  var CONFIG = {
    rollSelector: null,   // optional CSS selector for the roll container
    skipThreshold: 85,    // recommend a skip if the best pick scores under this
    mode: "adjusted"      // "standard" or "adjusted"; set from the popup
  };

  var state = {
    players: [],
    byTeamEra: {},
    teamLookup: {},       // lowercased team name/abbr -> abbr
    eras: [],
    roster: {},           // slot -> player
    lastRollKey: null
  };

  var panel, body, toggleBtn;

  // ---- settings ---------------------------------------------------------

  var DEFAULTS = { mode: "adjusted", skipThreshold: 85 };

  function loadSettings(done) {
    chrome.storage.local.get("settings", function (res) {
      var s = res.settings || {};
      CONFIG.mode = s.mode || DEFAULTS.mode;
      CONFIG.skipThreshold =
        typeof s.skipThreshold === "number" ? s.skipThreshold : DEFAULTS.skipThreshold;
      if (done) done();
    });
  }

  // Live-update when the popup writes new settings, and re-pull data on demand.
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" || !changes.settings) return;
    var s = changes.settings.newValue || {};
    if (s.mode) CONFIG.mode = s.mode;
    if (typeof s.skipThreshold === "number") CONFIG.skipThreshold = s.skipThreshold;
    if (panel) render();
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "RELOAD_DATA") requestPlayers(true);
  });

  // ---- data -------------------------------------------------------------

  function requestPlayers(forceRefresh) {
    chrome.runtime.sendMessage(
      { type: "GET_PLAYERS", forceRefresh: !!forceRefresh },
      function (resp) {
        if (!resp || !resp.players) return;
        indexPlayers(resp.players);
        state.lastRollKey = null; // force a fresh draw
        start();
      }
    );
  }

  function indexPlayers(players) {
    state.players = players;
    state.byTeamEra = {};
    var eras = {};

    players.forEach(function (p) {
      var key = p.team + "|" + p.era;
      (state.byTeamEra[key] || (state.byTeamEra[key] = [])).push(p);
      eras[p.era] = true;

      var abbr = p.team;
      state.teamLookup[abbr.toLowerCase()] = abbr;
      var full = Solver.TEAM_NAMES[abbr];
      if (full) state.teamLookup[full.toLowerCase()] = abbr;
    });

    state.eras = Object.keys(eras).sort();
  }

  // ---- roll detection ---------------------------------------------------

  function normalizeEra(text) {
    // matches "1990s", "90s", "1990's"
    var m = text.match(/\b((?:19|20)\d0)\s*'?s\b/);
    if (m) return m[1] + "s";
    m = text.match(/\b(\d0)\s*'?s\b/);
    if (m) {
      var n = parseInt(m[1], 10);
      return (n >= 60 ? "19" : "20") + m[1] + "s";
    }
    return null;
  }

  // Page text with our own overlay stripped out, so detection never matches the
  // helper's own recommendations or echoed roll.
  function pageText() {
    var text = document.body.innerText || "";
    [panel, toggleBtn].forEach(function (el) {
      if (el) {
        var t = el.innerText || "";
        if (t) text = text.split(t).join(" ");
      }
    });
    return text;
  }

  // The game's start screen shows a decorative team/era before you press Spin,
  // but the actual player pool isn't rendered yet. Treat a roll as live only
  // once several of that pool's players are actually on the page.
  function selectionActive(pool, text) {
    if (!pool || !pool.length) return false;
    var lower = (text != null ? text : pageText()).toLowerCase();
    var hits = 0;
    for (var i = 0; i < pool.length; i++) {
      var name = (pool[i].player || "").toLowerCase();
      if (name.length > 4 && lower.indexOf(name) !== -1) {
        if (++hits >= 3) return true;
      }
    }
    return false;
  }

  function detectRoll(text) {
    if (CONFIG.rollSelector) {
      var scope = document.querySelector(CONFIG.rollSelector);
      text = scope ? scope.innerText || "" : "";
    } else if (text == null) {
      text = pageText();
    }

    var era = normalizeEra(text);

    // Find a team by checking the recognized names/abbreviations against the
    // page text. Longer names first so "New Orleans Hornets" wins over a bare
    // "Hornets" style partial.
    var names = Object.keys(state.teamLookup).sort(function (a, b) {
      return b.length - a.length;
    });
    var lower = text.toLowerCase();
    var team = null;
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (name.length < 3) continue;
      if (lower.indexOf(name) !== -1) { team = state.teamLookup[name]; break; }
    }

    if (!team || !era) return null;
    return { team: team, era: era };
  }

  // ---- roster -----------------------------------------------------------

  function rosterArray() {
    return Solver.SLOTS
      .map(function (s) {
        var p = state.roster[s];
        return p ? Object.assign({}, p, { _slot: s }) : null;
      })
      .filter(Boolean);
  }

  function openPositions() {
    return Solver.SLOTS.filter(function (s) { return !state.roster[s]; });
  }

  function addToRoster(player, slot) {
    state.roster[slot] = player;
    render();
  }

  function clearSlot(slot) {
    delete state.roster[slot];
    render();
  }

  // ---- rendering --------------------------------------------------------

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "draft-helper-panel";
    panel.innerHTML =
      '<div class="dh-head">' +
        '<span class="dh-title">82-0 Helper</span>' +
        '<span><button class="dh-min" title="Hide">–</button></span>' +
      '</div>' +
      '<div class="dh-body"></div>';
    document.body.appendChild(panel);
    body = panel.querySelector(".dh-body");

    toggleBtn = document.createElement("button");
    toggleBtn.id = "draft-helper-toggle";
    toggleBtn.textContent = "82-0 Helper";
    toggleBtn.style.display = "none";
    document.body.appendChild(toggleBtn);

    panel.querySelector(".dh-min").addEventListener("click", function () {
      panel.style.display = "none";
      toggleBtn.style.display = "block";
    });
    toggleBtn.addEventListener("click", function () {
      panel.style.display = "block";
      toggleBtn.style.display = "none";
    });

    makeDraggable(panel, panel.querySelector(".dh-head"));
  }

  function render() {
    var text = pageText();
    var roll = detectRoll(text);
    var html = "";

    if (roll) {
      var teamName = Solver.TEAM_NAMES[roll.team] || roll.team;
      html += '<div class="dh-roll">Roll: <b>' + esc(teamName) +
        "</b> &middot; <b>" + esc(roll.era) + "</b></div>";

      var pool = state.byTeamEra[roll.team + "|" + roll.era] || [];

      if (!selectionActive(pool, text)) {
        html += '<div class="dh-roll">Start screen — press <b>Spin</b> to begin. ' +
          "Not counting this as a pick.</div>";
        html += renderRoster();
        body.innerHTML = html;
        body.querySelectorAll(".dh-clear").forEach(function (el) {
          el.addEventListener("click", function () { clearSlot(el.dataset.slot); });
        });
        return;
      }

      var open = openPositions();
      var ranked = Solver.rankPool(pool, open, { mode: CONFIG.mode });

      if (ranked.length === 0) {
        html += '<div class="dh-roll">No players in this pool fit an open slot.</div>';
      } else {
        var top = ranked.slice(0, 3);
        var base = rosterArray();

        if (top[0].value < CONFIG.skipThreshold) {
          html += '<div class="dh-skip">Weak roll — best fit only adds ' +
            top[0].value.toFixed(1) + '. Consider a skip if you have one.</div>';
        }

        top.forEach(function (r, idx) {
          var projected = Solver[CONFIG.mode === "adjusted"
            ? "calculateAdjustedOvr" : "calculateTeamOvr"](
            base.concat([Object.assign({}, r.player, { _slot: r.slot })])
          );
          var wins = Solver.projectedWins(projected, CONFIG.mode === "adjusted");

          html += '<div class="dh-pick">' +
            '<div><div class="dh-name">' + (idx + 1) + ". " + esc(r.player.player) +
              '</div><div class="dh-meta">' + r.slot + " · " +
              fmtLine(r.player) + '</div></div>' +
            '<div class="dh-num"><div class="dh-ovr">' + projected.toFixed(1) +
              '</div><div class="dh-meta">' + wins + ' W</div></div>' +
            '<button class="dh-add" data-i="' + idx + '">Add</button>' +
          '</div>';
        });

        // wire up the Add buttons after injecting
        setTimeout(function () {
          var btns = body.querySelectorAll(".dh-add");
          btns.forEach(function (btn) {
            btn.addEventListener("click", function () {
              var r = top[parseInt(btn.dataset.i, 10)];
              addToRoster(r.player, r.slot);
            });
          });
        }, 0);
      }
    } else {
      html += '<div class="dh-roll">Waiting for a team/era roll…</div>';
    }

    html += renderRoster();
    body.innerHTML = html;

    // roster controls
    body.querySelectorAll(".dh-clear").forEach(function (el) {
      el.addEventListener("click", function () { clearSlot(el.dataset.slot); });
    });
  }

  function renderRoster() {
    var filled = rosterArray();
    var ovr = Solver[CONFIG.mode === "adjusted"
      ? "calculateAdjustedOvr" : "calculateTeamOvr"](filled);
    var wins = Solver.projectedWins(ovr, CONFIG.mode === "adjusted");
    var g = Solver.gradeForWins(wins);

    var rows = Solver.SLOTS.map(function (s) {
      var p = state.roster[s];
      if (p) {
        return '<div class="dh-slot"><span>' + s + " " + esc(p.player) +
          '</span><span class="dh-clear" data-slot="' + s + '" title="Remove">×</span></div>';
      }
      return '<div class="dh-slot"><span class="dh-empty">' + s + " — open</span></div>";
    }).join("");

    return '<div class="dh-roster"><h4>Roster</h4>' + rows +
      '<div class="dh-summary"><span>OVR ' + ovr.toFixed(1) + " · " +
      wins + ' wins</span><span class="dh-grade">' + g.grade + " " + g.label +
      '</span></div></div>';
  }

  function fmtLine(p) {
    return [p.ppg, p.rpg, p.apg].map(function (v) {
      return (v || 0).toFixed(1);
    }).join("/") + " p/r/a";
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---- misc -------------------------------------------------------------

  function makeDraggable(el, handle) {
    var dx = 0, dy = 0, sx = 0, sy = 0;
    handle.addEventListener("mousedown", function (e) {
      if (e.target.tagName === "BUTTON") return;
      sx = e.clientX; sy = e.clientY;
      var rect = el.getBoundingClientRect();
      dx = rect.left; dy = rect.top;
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      e.preventDefault();
    });
    function move(e) {
      el.style.left = dx + (e.clientX - sx) + "px";
      el.style.top = dy + (e.clientY - sy) + "px";
      el.style.right = "auto";
    }
    function up() {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    }
  }

  var renderTimer = null;
  function scheduleRender() {
    // Re-detect on a short debounce. Only redraw the pick list when the roll
    // actually changes, but always keep the roster summary current.
    clearTimeout(renderTimer);
    renderTimer = setTimeout(function () {
      var text = pageText();
      var roll = detectRoll(text);
      var active = roll
        ? selectionActive(state.byTeamEra[roll.team + "|" + roll.era] || [], text)
        : false;
      var key = (roll ? roll.team + "|" + roll.era : "none") + "|" + active;
      if (key !== state.lastRollKey) {
        state.lastRollKey = key;
        render();
      }
    }, 150);
  }

  var observing = false;
  function start() {
    if (!panel) buildPanel();
    render();

    if (observing) return;
    observing = true;
    var obs = new MutationObserver(scheduleRender);
    obs.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function init() {
    loadSettings(function () { requestPlayers(false); });
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
