/*
 * AI overlay for 82-0.com.
 * Forked conceptually from suryavjay/82-0.com-solver, with:
 * - exact Classic marginal OVR
 * - player/position recommendations ranked by projected 82-0 path probability
 * - optional immediate team/decade skip comparison
 * - max-two-of-any-team-era roll rule
 */
(function () {
  "use strict";

  var DEFAULTS = {
    strategyMode: "no_skips", // or "compare_skips"
    simulations: 200,
    teamSkipAvailable: true,
    decadeSkipAvailable: true
  };

  var CONFIG = Object.assign({}, DEFAULTS);

  var state = {
    players: [],
    byTeamEra: Object.create(null),
    poolsByEra: Object.create(null),
    roster: Object.create(null),
    lastRollKey: null,
    currentRoll: null,
    solveToken: 0,
    solveKey: null,
    solution: null,
    solving: false,
    error: null,
    actionByButton: []
  };

  var panel, body, toggleBtn;
  var observer = null;
  var renderTimer = null;
  var solveTimer = null;

  // ---------- settings ----------

  function loadSettings(done) {
    chrome.storage.local.get("settings", function (res) {
      CONFIG = Object.assign({}, DEFAULTS, res.settings || {});
      if (done) done();
    });
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" || !changes.settings) return;
    CONFIG = Object.assign({}, DEFAULTS, changes.settings.newValue || {});
    state.solveKey = null;
    state.solution = null;
    render();
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "RELOAD_DATA") requestPlayers(true);
  });

  // ---------- data ----------

  function requestPlayers(forceRefresh) {
    chrome.runtime.sendMessage(
      { type: "GET_PLAYERS", forceRefresh: !!forceRefresh },
      function (resp) {
        if (!resp || !resp.players || !resp.players.length) {
          state.error = "Could not load player data.";
          render();
          return;
        }
        indexPlayers(resp.players);
        state.lastRollKey = null;
        state.solveKey = null;
        state.solution = null;
        start();
      }
    );
  }

  function indexPlayers(players) {
    state.players = players.filter(function (p) { return p.era !== "1950s"; });
    state.byTeamEra = Object.create(null);
    state.poolsByEra = Object.create(null);

    state.players.forEach(function (p) {
      var key = p.team + "|" + p.era;
      (state.byTeamEra[key] || (state.byTeamEra[key] = [])).push(p);
      p._lname = (p.player || "").toLowerCase();
    });

    Object.keys(state.byTeamEra).forEach(function (key) {
      var parts = key.split("|"), era = parts[1];
      (state.poolsByEra[era] || (state.poolsByEra[era] = [])).push({
        team: parts[0],
        players: state.byTeamEra[key]
      });
    });
  }

  // ---------- live roll detection ----------

  function pageText() {
    var text = document.body ? (document.body.innerText || "") : "";
    [panel, toggleBtn].forEach(function (el) {
      if (!el) return;
      var t = el.innerText || "";
      if (t) text = text.split(t).join(" ");
    });
    return text;
  }

  var MIN_POOL_HITS = 3;

  function erasInText(text) {
    var found = Object.create(null), m;
    var re = /\b((?:19|20)\d0)\s*'?s\b/g;
    while ((m = re.exec(text))) found[m[1] + "s"] = true;

    var re2 = /\b(\d0)\s*'?s\b/g;
    while ((m = re2.exec(text))) {
      var n = parseInt(m[1], 10);
      found[(n >= 60 ? "19" : "20") + m[1] + "s"] = true;
    }
    return Object.keys(found);
  }

  function detectRoll(text) {
    if (text == null) text = pageText();
    var lower = text.toLowerCase();
    var eras = erasInText(text);
    var best = { team: null, era: null, hits: 0 };

    for (var e = 0; e < eras.length; e++) {
      var pools = state.poolsByEra[eras[e]] || [];
      for (var i = 0; i < pools.length; i++) {
        var ps = pools[i].players, hits = 0;
        for (var j = 0; j < ps.length; j++) {
          var name = ps[j]._lname;
          if (name && name.length > 4 && lower.indexOf(name) !== -1) hits++;
        }
        if (hits > best.hits) {
          best = { team: pools[i].team, era: eras[e], hits: hits };
        }
      }
    }

    if (!best.team || best.hits < MIN_POOL_HITS) return null;
    return { team: best.team, era: best.era };
  }

  // ---------- roster ----------

  function rosterArray() {
    return Solver.SLOTS.map(function (slot) {
      var p = state.roster[slot];
      return p ? Object.assign({}, p, { _slot: slot }) : null;
    }).filter(Boolean);
  }

  function acceptedHistory() {
    return rosterArray().map(function (p) { return p._rollKey; }).filter(Boolean);
  }

  function pickedKeys() {
    var set = Object.create(null);
    rosterArray().forEach(function (p) { set[(Solver.humanKey ? Solver.humanKey(p) : Solver.playerKey(p))] = true; });
    return set;
  }

  function addToRoster(action) {
    if (!action || action.type !== "pick") return;
    var currentKey = state.currentRoll
      ? state.currentRoll.team + "|" + state.currentRoll.era
      : null;
    state.roster[action.slot] = Object.assign({}, action.player, {
      _slot: action.slot,
      _rollKey: currentKey
    });
    state.solveKey = null;
    state.solution = null;
    render();
  }

  function clearSlot(slot) {
    delete state.roster[slot];
    state.solveKey = null;
    state.solution = null;
    render();
  }

  function clearRoster() {
    state.roster = Object.create(null);
    state.solveKey = null;
    state.solution = null;
    render();
  }

  // ---------- AI ----------

  function makeSolveKey(roll) {
    var rosterKey = rosterArray().map(function (p) {
      return p._slot + ":" + (Solver.humanKey ? Solver.humanKey(p) : Solver.playerKey(p)) + ":" + (p._rollKey || "");
    }).sort().join(",");
    return [
      roll.team, roll.era, rosterKey,
      CONFIG.strategyMode, CONFIG.simulations,
      CONFIG.teamSkipAvailable, CONFIG.decadeSkipAvailable
    ].join("|");
  }

  function requestSolve(roll) {
    if (!roll || rosterArray().length >= 5) return;

    var key = makeSolveKey(roll);
    if (key === state.solveKey && (state.solution || state.solving)) return;

    state.solveKey = key;
    state.solution = null;
    state.solving = true;
    state.error = null;
    state.solveToken += 1;
    var token = state.solveToken;

    var sims = Math.max(50, Math.min(1200, Number(CONFIG.simulations) || 200));
    var quality = sims >= 700 ? { beamWidth: 4, candidateLimit: 12 }
      : sims >= 250 ? { beamWidth: 3, candidateLimit: 10 }
      : { beamWidth: 2, candidateLimit: 9 };

    var request = {
      currentRoll: roll,
      roster: rosterArray(),
      history: acceptedHistory(),
      strategyMode: CONFIG.strategyMode,
      simulations: sims,
      beamWidth: quality.beamWidth,
      candidateLimit: quality.candidateLimit,
      teamSkipAvailable: CONFIG.teamSkipAvailable,
      decadeSkipAvailable: CONFIG.decadeSkipAvailable
    };

    try {
      chrome.runtime.sendMessage({ type: "SOLVE_PATHS", request: request }, function (resp) {
        if (token !== state.solveToken) return;

        // lastError is how Chrome reports a sleeping/crashed service worker or
        // missing receiver. Treat AI as optional; never take down base helper.
        if (chrome.runtime.lastError) {
          state.solving = false;
          state.error = "AI unavailable; showing OVR-only recommendations.";
          render(false);
          return;
        }
        if (!resp || resp.error || !resp.result) {
          state.solving = false;
          state.error = (resp && resp.error) ||
            "AI unavailable; showing OVR-only recommendations.";
          render(false);
          return;
        }

        state.solution = resp.result;
        state.solving = false;
        state.error = null;
        render(false);
      });
    } catch (err) {
      state.solving = false;
      state.error = "AI unavailable; showing OVR-only recommendations.";
      render(false);
    }
  }

  function scheduleSolve(roll) {
    clearTimeout(solveTimer);
    solveTimer = setTimeout(function () { requestSolve(roll); }, 120);
  }

  // ---------- annotations ----------

  function rollPpgRank(pool, player) {
    var vals = pool.slice().sort(function (a, b) {
      return (Number(b.ppg) || 0) - (Number(a.ppg) || 0);
    });
    for (var i = 0; i < vals.length; i++) {
      if ((Solver.humanKey ? Solver.humanKey(vals[i]) : Solver.playerKey(vals[i])) === (Solver.humanKey ? Solver.humanKey(player) : Solver.playerKey(player))) return i + 1;
    }
    return null;
  }

  function rollOvrLeader(pool) {
    var best = null, bestVal = -Infinity;
    pool.forEach(function (p) {
      var v = Solver.standardContribution(p);
      if (v > bestVal) { bestVal = v; best = p; }
    });
    return best;
  }

  function badgesFor(pool, action) {
    var badges = [];
    var leader = rollOvrLeader(pool);
    var ppgRank = rollPpgRank(pool, action.player);

    if (leader && (Solver.humanKey ? Solver.humanKey(leader) : Solver.playerKey(leader)) === (Solver.humanKey ? Solver.humanKey(action.player) : Solver.playerKey(action.player)) && ppgRank > 1) {
      badges.push("OVR #1 · PPG #" + ppgRank);
    }
    if ((Number(action.player.ppg) || 0) <= 12 && action.standaloneOvr >= 14) {
      badges.push("low-PPG sleeper");
    }
    return badges;
  }

  // ---------- rendering ----------

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "draft-helper-panel";
    panel.innerHTML =
      '<div class="dh-head">' +
        '<span class="dh-title">82-0 AI Helper</span>' +
        '<button class="dh-min" title="Hide">–</button>' +
      '</div>' +
      '<div class="dh-body"></div>';
    document.body.appendChild(panel);
    body = panel.querySelector(".dh-body");

    toggleBtn = document.createElement("button");
    toggleBtn.id = "draft-helper-toggle";
    toggleBtn.textContent = "82-0 AI";
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

  function render(shouldSolve) {
    if (shouldSolve !== false) shouldSolve = true;
    if (!panel) return;

    var roll = detectRoll();
    state.currentRoll = roll;
    var html = "";
    state.actionByButton = [];

    if (!roll) {
      html += '<div class="dh-roll">Waiting for a roll — press <b>Spin</b>.</div>';
      html += renderRoster();
      setBody(html);
      return;
    }

    var rollKey = roll.team + "|" + roll.era;
    var pool = state.byTeamEra[rollKey] || [];
    var teamName = Solver.TEAM_NAMES[roll.team] || roll.team;

    html += '<div class="dh-roll">Roll: <b>' + esc(teamName) +
      '</b> · <b>' + esc(roll.era) + '</b></div>';

    html += '<div class="dh-model">' +
      (CONFIG.strategyMode === "no_skips" ? "No-skips AI" : "Skip comparison") +
      ' · max 2× same team-era · Classic</div>';

    var base = rosterArray();
    var immediate = Solver.currentActions(base, pool).filter(function (a) {
      return !pickedKeys()[(Solver.humanKey ? Solver.humanKey(a.player) : Solver.playerKey(a.player))];
    });

    if (!immediate.length) {
      html += '<div class="dh-note">No legal player fits an open position.</div>';
    } else if (state.solution && state.solveKey === makeSolveKey(roll)) {
      html += renderSolution(pool, state.solution);
    } else {
      html += '<div class="dh-ai-status">' +
        (state.error ? "AI unavailable — OVR-only fallback" : "Calculating 82-0 path odds…") +
        '</div>';
      html += renderImmediateFallback(pool, immediate.slice(0, 3));
    }

    if (state.error) {
      html += '<div class="dh-error">' + esc(state.error) + '</div>';
    }

    html += renderRoster();
    setBody(html);
    wireButtons();

    if (shouldSolve) scheduleSolve(roll);
  }

  function renderImmediateFallback(pool, actions) {
    var html = '<div class="dh-section-title">Best current OVR</div>';
    actions.forEach(function (a) {
      html += pickRowHtml(pool, {
        type: "pick",
        player: a.player,
        slot: a.slot,
        immediateOvr: a.ovr,
        marginalOvr: a.marginal,
        standaloneOvr: a.standalone,
        probability: null
      }, false);
    });
    return html;
  }

  function renderSolution(pool, solution) {
    var html = '<div class="dh-section-title">Projected 82-0 path</div>';
    var top = (solution.actions || []).slice(0, 5);

    if (!top.length) {
      html += '<div class="dh-note">No legal AI actions.</div>';
    } else {
      top.forEach(function (a, idx) {
        html += pickRowHtml(pool, a, idx === 0);
      });
    }

    if (CONFIG.strategyMode === "compare_skips" && solution.skips && solution.skips.length) {
      html += '<div class="dh-section-title dh-skip-title">Immediate skip comparison</div>';
      solution.skips.forEach(function (s) {
        var label = s.type === "team_skip" ? "Team skip" : "Decade skip";
        html += '<div class="dh-skip-row">' +
          '<div><div class="dh-name">' + label + '</div>' +
          '<div class="dh-meta">reroll now; later skips not modeled</div></div>' +
          '<div class="dh-prob">≈' + pct(s.probability) + '</div>' +
        '</div>';
      });
    }

    html += '<div class="dh-footnote">' +
      (solution.exact
        ? "Exact over the remaining roll."
        : "≈ Monte Carlo oracle-path estimate (" + solution.scenarios + " scenarios).") +
      '</div>';
    return html;
  }

  function pickRowHtml(pool, a, best) {
    var idx = state.actionByButton.length;
    state.actionByButton.push(a);

    var badges = badgesFor(pool, a);
    var badgeHtml = badges.map(function (b) {
      return '<span class="dh-badge">' + esc(b) + '</span>';
    }).join("");

    var probHtml = a.probability == null
      ? '<div class="dh-prob dh-prob-muted">OVR</div>'
      : '<div class="dh-prob">' + probabilityLabel(a) + '</div>';

    return '<div class="dh-pick ' + (best ? "dh-best" : "") + '">' +
      '<div class="dh-pick-main">' +
        '<div class="dh-name">' + esc(a.player.player) + ' <span class="dh-arrow">→ ' +
          esc(a.slot) + '</span></div>' +
        '<div class="dh-meta">' + fmtLine(a.player) + '</div>' +
        '<div class="dh-badges">' + badgeHtml + '</div>' +
        '<div class="dh-meta">standalone ' + Number(a.standaloneOvr || 0).toFixed(1) +
          ' · pick +' + Number(a.marginalOvr || 0).toFixed(1) +
          ' · team ' + Number(a.immediateOvr || 0).toFixed(1) + '</div>' +
      '</div>' +
      '<div class="dh-pick-side">' + probHtml +
        '<div class="dh-meta">' + (a.probability == null ? 'current' : '82-0') + '</div>' +
        '<button class="dh-add" data-action="' + idx + '">Add</button>' +
      '</div>' +
    '</div>';
  }

  function renderRoster() {
    var filled = rosterArray();
    var ovr = Solver.calculateTeamOvr(filled);
    var wins = Solver.projectedWins(ovr);
    var grade = Solver.gradeForWins(wins);

    var rows = Solver.SLOTS.map(function (slot) {
      var p = state.roster[slot];
      if (!p) return '<div class="dh-slot"><span class="dh-empty">' + slot + ' — open</span></div>';
      return '<div class="dh-slot"><span>' + slot + ' ' + esc(p.player) +
        '</span><button class="dh-clear" data-slot="' + slot + '" title="Remove">×</button></div>';
    }).join("");

    return '<div class="dh-roster"><div class="dh-roster-head">' +
      '<div class="dh-section-title">Roster</div>' +
      (filled.length ? '<button class="dh-clear-all" title="Remove all picks">Clear Roster</button>' : '') +
      '</div>' +
      rows +
      '<div class="dh-summary"><span>OVR ' + ovr.toFixed(1) + ' · ' + wins +
      ' wins</span><span class="dh-grade">' + grade.grade + ' ' + grade.label +
      '</span></div></div>';
  }

  function setBody(html) {
    pauseObserver();
    body.innerHTML = html;
    resumeObserver();
  }

  function wireButtons() {
    body.querySelectorAll(".dh-add").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var action = state.actionByButton[parseInt(btn.dataset.action, 10)];
        addToRoster(action);
      });
    });

    body.querySelectorAll(".dh-clear").forEach(function (btn) {
      btn.addEventListener("click", function () { clearSlot(btn.dataset.slot); });
    });

    var clearAllBtn = body.querySelector(".dh-clear-all");
    if (clearAllBtn) clearAllBtn.addEventListener("click", clearRoster);
  }


  function probabilityLabel(a) {
    if (a.exact) return pct(a.probability);
    if (Number(a.probability || 0) === 0 && a.scenarios) {
      return "&lt;" + (100 / a.scenarios).toFixed(a.scenarios >= 200 ? 1 : 2) + "%";
    }
    return "≈" + pct(a.probability);
  }

  function pct(x) {
    return (100 * Number(x || 0)).toFixed(x > 0 && x < 0.01 ? 2 : 1) + "%";
  }

  function fmtLine(p) {
    return [
      Number(p.ppg || 0).toFixed(1),
      Number(p.rpg || 0).toFixed(1),
      Number(p.apg || 0).toFixed(1),
      Number(p.spg || 0).toFixed(1),
      Number(p.bpg || 0).toFixed(1)
    ].join("/") + " P/R/A/S/B";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---------- misc ----------

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

  var OBS_OPTS = { childList: true, subtree: true, characterData: true };

  function pauseObserver() {
    if (observer) observer.disconnect();
  }

  function resumeObserver() {
    if (observer && document.body) observer.observe(document.body, OBS_OPTS);
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(function () {
      try {
        var roll = detectRoll();
        var key = roll ? roll.team + "|" + roll.era : "none";
        if (key !== state.lastRollKey) {
          state.lastRollKey = key;
          state.solveKey = null;
          state.solution = null;
          render();
        }
      } catch (e) {}
    }, 300);
  }

  function start() {
    if (!panel) buildPanel();
    render();

    if (!observer) {
      observer = new MutationObserver(scheduleRender);
      resumeObserver();
    }
  }

  function init() {
    loadSettings(function () { requestPlayers(false); });
  }

  if (document.body) init();
  else document.addEventListener("DOMContentLoaded", init);
})();
