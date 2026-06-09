/*
 * Runs on 82-0.com. Reads whatever team/era is currently rolled out of the
 * page, looks up the matching player pool, and shows the picks that move the
 * team OVR the most. The site is a Next.js app that swaps content in place, so
 * we watch the DOM with a MutationObserver instead of relying on page loads.
 *
 * The page markup isn't documented anywhere, so roll detection is data-driven:
 * we read a decade token (e.g. "1990s") from the page and then figure out the
 * team by which team's player pool is actually rendered on screen. Because the
 * player names come from the same dataset the site uses, they match exactly.
 */

(function () {
  "use strict";

  var CONFIG = {
    skipThreshold: 85,    // recommend a skip if the best pick scores under this
    mode: "adjusted"      // "standard" or "adjusted"; set from the popup
  };

  var state = {
    players: [],
    byTeamEra: {},
    poolsByEra: {},       // era -> [{ team, players }] for roll detection
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
    state.poolsByEra = {};
    var eras = {};

    players.forEach(function (p) {
      var key = p.team + "|" + p.era;
      (state.byTeamEra[key] || (state.byTeamEra[key] = [])).push(p);
      eras[p.era] = true;
      p._lname = (p.player || "").toLowerCase(); // cached for page matching
    });

    // Group pools by era so a roll can be identified from the players on screen.
    Object.keys(state.byTeamEra).forEach(function (key) {
      var parts = key.split("|");
      var era = parts[1];
      (state.poolsByEra[era] || (state.poolsByEra[era] = [])).push({
        team: parts[0],
        players: state.byTeamEra[key]
      });
    });

    state.eras = Object.keys(eras).sort();
  }

  // ---- roll detection ---------------------------------------------------

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

  // How many of a pool's players must appear on the page to call it the live
  // roll. Also serves as the "selection has actually started" signal — on the
  // pre-spin start screen no pool is rendered, so nothing crosses this bar.
  var MIN_POOL_HITS = 3;

  function erasInText(text) {
    var found = {}, m;
    var re = /\b((?:19|20)\d0)\s*'?s\b/g;
    while ((m = re.exec(text))) found[m[1] + "s"] = true;
    var re2 = /\b(\d0)\s*'?s\b/g;
    while ((m = re2.exec(text))) {
      var n = parseInt(m[1], 10);
      found[(n >= 60 ? "19" : "20") + m[1] + "s"] = true;
    }
    return Object.keys(found);
  }

  // Identify the current roll from the players actually rendered on the page.
  // Every selectable player in a roll shares one team+era, so the pool with the
  // most name matches IS the roll. This avoids latching onto stale team names
  // left elsewhere on the page after earlier picks (the second-roll bug).
  function detectRoll(text) {
    if (text == null) text = pageText();
    var lower = text.toLowerCase();
    var eras = erasInText(text);

    var best = { team: null, era: null, hits: 0 };
    for (var e = 0; e < eras.length; e++) {
      var pools = state.poolsByEra[eras[e]] || [];
      for (var i = 0; i < pools.length; i++) {
        var players = pools[i].players, hits = 0;
        for (var j = 0; j < players.length; j++) {
          var name = players[j]._lname;
          if (name.length > 4 && lower.indexOf(name) !== -1) hits++;
        }
        if (hits > best.hits) {
          best = { team: pools[i].team, era: eras[e], hits: hits };
        }
      }
    }

    if (!best.team || best.hits < MIN_POOL_HITS) return null;
    return { team: best.team, era: best.era };
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

  // Keys of players already drafted, so they're never recommended again.
  function pickedKeys() {
    var set = {};
    rosterArray().forEach(function (p) { set[Solver.playerKey(p)] = true; });
    return set;
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
      var open = openPositions();
      var ranked = Solver.rankPool(pool, open, {
        mode: CONFIG.mode,
        exclude: pickedKeys()
      });

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
      html += '<div class="dh-roll">Waiting for a roll — press <b>Spin</b> to load a pool.</div>';
    }

    html += renderRoster();

    // Pause the observer while we mutate our own panel so it doesn't re-trigger
    // detection on every redraw.
    pauseObserver();
    body.innerHTML = html;
    body.querySelectorAll(".dh-clear").forEach(function (el) {
      el.addEventListener("click", function () { clearSlot(el.dataset.slot); });
    });
    resumeObserver();
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

  var observer = null;
  var OBS_OPTS = { childList: true, subtree: true, characterData: true };

  function pauseObserver() {
    if (observer) observer.disconnect();
  }
  function resumeObserver() {
    if (observer) observer.observe(document.body, OBS_OPTS);
  }

  var renderTimer = null;
  function scheduleRender() {
    // Detect on a debounce after DOM churn settles, and only redraw when the
    // roll actually changes so the page isn't doing extra work mid-animation.
    clearTimeout(renderTimer);
    renderTimer = setTimeout(function () {
      try {
        var roll = detectRoll();
        var key = roll ? roll.team + "|" + roll.era : "none";
        if (key !== state.lastRollKey) {
          state.lastRollKey = key;
          render();
        }
      } catch (e) {
        /* never let detection break the page */
      }
    }, 300);
  }

  function start() {
    if (!panel) buildPanel();
    render();

    if (observer) return;
    observer = new MutationObserver(scheduleRender);
    resumeObserver();
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
