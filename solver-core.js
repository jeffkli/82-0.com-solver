/*
 * Scoring math for the 82-0 draft game.
 *
 * This preserves the upstream solver API (Standard + Adjusted modes) and adds
 * Classic-only helpers used by the AI path-odds layer.  Keeping the original
 * API intact is intentional: AI failures should never break the known-working
 * helper or standalone solver.
 */
var Solver = (function () {
  "use strict";

  var WEIGHT = { ppg: 0.46, rpg: 0.25, apg: 0.18, spg: 0.07, bpg: 0.04 };
  var DENOM = { ppg: 133.4, rpg: 39.7, apg: 29.3, spg: 6.1, bpg: 3.2 };

  var ERA_BASELINES = {
    "1960s": { ppg: 30, rpg: 18, apg: 8, spg: 1.8, bpg: 1.8 },
    "1970s": { ppg: 28, rpg: 13, apg: 9, spg: 2, bpg: 2 },
    "1980s": { ppg: 28, rpg: 11, apg: 11, spg: 2.2, bpg: 2 },
    "1990s": { ppg: 27, rpg: 11, apg: 9, spg: 2, bpg: 2 },
    "2000s": { ppg: 27, rpg: 11, apg: 9, spg: 2, bpg: 2 },
    "2010s": { ppg: 28, rpg: 11, apg: 9, spg: 1.8, bpg: 1.8 },
    "2020s": { ppg: 28, rpg: 11, apg: 9, spg: 1.8, bpg: 1.8 }
  };

  var POSITION_WEIGHTS = {
    PG: { ppg: 0.4, rpg: 0.1, apg: 0.35, spg: 0.1, bpg: 0.05 },
    SG: { ppg: 0.45, rpg: 0.1, apg: 0.2, spg: 0.2, bpg: 0.05 },
    SF: { ppg: 0.45, rpg: 0.15, apg: 0.2, spg: 0.15, bpg: 0.05 },
    PF: { ppg: 0.4, rpg: 0.3, apg: 0.1, spg: 0.1, bpg: 0.1 },
    C: { ppg: 0.4, rpg: 0.35, apg: 0.1, spg: 0.05, bpg: 0.1 }
  };

  var LEGACY = new Set([
    "larry bird", "tim duncan", "kevin durant", "magic johnson",
    "shaquille o'neal", "hakeem olajuwon", "bill russell", "kobe bryant",
    "oscar robertson", "karl malone", "kevin garnett", "isiah thomas",
    "tony parker", "manu ginobili", "draymond green", "scottie pippen",
    "dennis rodman", "stephen curry", "nikola jokic", "dirk nowitzki"
  ]);

  var STATS = ["ppg", "rpg", "apg", "spg", "bpg"];
  var SLOTS = ["PG", "SG", "SF", "PF", "C"];

  var TEAM_NAMES = {
    ATL: "Atlanta Hawks", BOS: "Boston Celtics", BKN: "Brooklyn Nets",
    NJN: "New Jersey Nets", CHA: "Charlotte Hornets", CHH: "Charlotte Hornets",
    CHI: "Chicago Bulls", CLE: "Cleveland Cavaliers", DAL: "Dallas Mavericks",
    DEN: "Denver Nuggets", DET: "Detroit Pistons", GSW: "Golden State Warriors",
    HOU: "Houston Rockets", IND: "Indiana Pacers", LAC: "Los Angeles Clippers",
    LAL: "Los Angeles Lakers", MEM: "Memphis Grizzlies", MIA: "Miami Heat",
    MIL: "Milwaukee Bucks", MIN: "Minnesota Timberwolves",
    NOP: "New Orleans Pelicans", NOH: "New Orleans Hornets",
    NYK: "New York Knicks", OKC: "Oklahoma City Thunder",
    SEA: "Seattle SuperSonics", ORL: "Orlando Magic",
    PHI: "Philadelphia 76ers", PHX: "Phoenix Suns",
    POR: "Portland Trail Blazers", SAC: "Sacramento Kings",
    SAS: "San Antonio Spurs", TOR: "Toronto Raptors", UTA: "Utah Jazz",
    WAS: "Washington Wizards", WSB: "Washington Bullets"
  };

  function num(v) {
    var x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }

  function round1(x) { return Math.round(x * 10) / 10; }

  function total(players, key) {
    return (players || []).reduce(function (s, p) { return s + num(p[key]); }, 0);
  }

  // Classic's positive-only STL/BLK normalization.
  function adjustStat(players, key) {
    var vals = (players || []).map(function (p) { return num(p[key]); })
      .filter(function (v) { return v > 0; });
    if (!vals.length) return 0;
    return vals.reduce(function (a, b) { return a + b; }, 0) * 5 / vals.length;
  }

  function calculateTeamOvrUnrounded(players) {
    if (!players || !players.length) return 0;
    return 100 * (
      total(players, "ppg") / DENOM.ppg * WEIGHT.ppg +
      total(players, "rpg") / DENOM.rpg * WEIGHT.rpg +
      total(players, "apg") / DENOM.apg * WEIGHT.apg +
      adjustStat(players, "spg") / DENOM.spg * WEIGHT.spg +
      adjustStat(players, "bpg") / DENOM.bpg * WEIGHT.bpg
    );
  }

  function calculateTeamOvr(players) { return round1(calculateTeamOvrUnrounded(players)); }

  function playerOvr(p, slot) {
    var era = ERA_BASELINES[p.era] || ERA_BASELINES["1960s"];
    var pos = POSITION_WEIGHTS[slot || (p.positions && p.positions[0])];
    if (!pos) return 60;
    var sum = 0;
    for (var i = 0; i < STATS.length; i++) {
      var k = STATS[i];
      var ratio = era[k] ? num(p[k]) / era[k] : 0;
      if (ratio > 1) ratio = Math.pow(ratio, 1.25);
      sum += ratio * pos[k];
    }
    var ovr = 60 + 40 * sum;
    if (p.player && LEGACY.has(p.player.toLowerCase())) ovr += 2.5;
    return ovr;
  }

  function calculateAdjustedOvr(players) {
    if (!players || !players.length) return 0;
    var product = 1;
    for (var i = 0; i < players.length; i++) {
      product *= playerOvr(players[i], players[i]._slot);
    }
    return round1(1.1 * Math.pow(product, 1 / players.length));
  }

  function projectedWins(ovr, adjusted) {
    var exp = adjusted ? 2.2 : 1.15;
    return Math.round(82 * Math.pow(Math.min(Math.max(ovr, 0) / 110, 1), exp));
  }

  function isPerfect(players) { return projectedWins(calculateTeamOvr(players), false) >= 82; }

  function gradeForWins(wins) {
    if (wins >= 80) return { grade: "S", label: "PERFECT" };
    if (wins >= 72) return { grade: "A+", label: "HISTORIC" };
    if (wins >= 62) return { grade: "A", label: "DYNASTY" };
    if (wins >= 57) return { grade: "B", label: "CONTENDER" };
    if (wins >= 50) return { grade: "C", label: "PLAYOFF" };
    if (wins >= 40) return { grade: "D", label: "LOTTERY" };
    return { grade: "F", label: "TANKING" };
  }

  function calc(mode) { return mode === "adjusted" ? calculateAdjustedOvr : calculateTeamOvr; }

  function canFill(player, slot) {
    return player.positions && player.positions.indexOf(slot) !== -1;
  }

  // Preserve upstream entry identity semantics for existing helper APIs.
  function playerKey(p) {
    return p.id || ((p.player || "") + "|" + (p.team || "") + "|" + (p.era || ""));
  }

  // AI uses human identity so one person cannot be selected through a second
  // team/decade variant later in the same roster.
  function humanKey(p) { return p.baseSlug || playerKey(p); }

  function rosterKeySet(roster, keyFn) {
    keyFn = keyFn || playerKey;
    var set = Object.create(null);
    (roster || []).forEach(function (p) { set[keyFn(p)] = true; });
    return set;
  }

  function standardContribution(p) {
    return 100 * (
      num(p.ppg) / DENOM.ppg * WEIGHT.ppg +
      num(p.rpg) / DENOM.rpg * WEIGHT.rpg +
      num(p.apg) / DENOM.apg * WEIGHT.apg +
      num(p.spg) / DENOM.spg * WEIGHT.spg +
      num(p.bpg) / DENOM.bpg * WEIGHT.bpg
    );
  }

  function bestPick(roster, available, openPositions, opts) {
    opts = opts || {};
    var score = calc(opts.mode);
    var taken = rosterKeySet(roster);
    var best = null;
    for (var i = 0; i < available.length; i++) {
      var p = available[i];
      if (taken[playerKey(p)]) continue;
      for (var j = 0; j < openPositions.length; j++) {
        var slot = openPositions[j];
        if (!canFill(p, slot)) continue;
        var cand = Object.assign({}, p, { _slot: slot });
        var ovr = score(roster.concat([cand]));
        if (!best || ovr > best.ovr) best = { player: p, slot: slot, ovr: ovr };
      }
    }
    return best;
  }

  function groupPools(players) {
    var map = {};
    for (var i = 0; i < players.length; i++) {
      var p = players[i], key = p.team + "|" + p.era;
      (map[key] || (map[key] = [])).push(p);
    }
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  function blankPlayer(slot) {
    var p = { player: "(expected)", _slot: slot, positions: [slot] };
    STATS.forEach(function (k) { p[k] = 0; });
    return p;
  }

  function expectedBestForSlot(pools, slot, opts) {
    var mode = opts.mode, picks = [];
    for (var i = 0; i < pools.length; i++) {
      var pool = pools[i], bestP = null, bestScore = -Infinity;
      for (var j = 0; j < pool.length; j++) {
        var c = pool[j];
        if (!canFill(c, slot)) continue;
        var s = mode === "adjusted" ? playerOvr(c, slot) : standardContribution(c);
        if (s > bestScore) { bestScore = s; bestP = c; }
      }
      if (bestP) picks.push(bestP);
    }
    if (!picks.length) return blankPlayer(slot);
    var avg = blankPlayer(slot);
    STATS.forEach(function (k) {
      avg[k] = picks.reduce(function (s, p) { return s + num(p[k]); }, 0) / picks.length;
    });
    return avg;
  }

  function expectedValuePick(roster, available, openPositions, allPlayers, opts) {
    opts = opts || {};
    var score = calc(opts.mode), pools = groupPools(allPlayers), fillerCache = {};
    function filler(slot) {
      if (!fillerCache[slot]) fillerCache[slot] = expectedBestForSlot(pools, slot, opts);
      return fillerCache[slot];
    }
    var taken = rosterKeySet(roster), best = null;
    for (var i = 0; i < available.length; i++) {
      var p = available[i];
      if (taken[playerKey(p)]) continue;
      for (var j = 0; j < openPositions.length; j++) {
        var slot = openPositions[j];
        if (!canFill(p, slot)) continue;
        var remaining = openPositions.slice();
        remaining.splice(j, 1);
        var projected = roster.concat([Object.assign({}, p, { _slot: slot })])
          .concat(remaining.map(filler));
        var ev = score(projected);
        if (!best || ev > best.ev) best = { player: p, slot: slot, ev: round1(ev) };
      }
    }
    return best;
  }

  function rankPool(pool, openPositions, opts) {
    opts = opts || {};
    var mode = opts.mode, exclude = opts.exclude, out = [];
    for (var i = 0; i < pool.length; i++) {
      var p = pool[i];
      if (exclude && (exclude.has ? exclude.has(playerKey(p)) : exclude[playerKey(p)])) continue;
      var slots = (p.positions || []).filter(function (s) {
        return !openPositions || openPositions.indexOf(s) !== -1;
      });
      if (!slots.length) continue;
      var bestSlot = slots[0], bestScore = -Infinity;
      for (var s = 0; s < slots.length; s++) {
        var val = mode === "adjusted" ? playerOvr(p, slots[s]) : standardContribution(p);
        if (val > bestScore) { bestScore = val; bestSlot = slots[s]; }
      }
      out.push({ player: p, slot: bestSlot, value: round1(bestScore) });
    }
    out.sort(function (a, b) { return b.value - a.value; });
    return out;
  }

  // ---- AI-only helpers -------------------------------------------------

  function openPositionsForRoster(roster) {
    var used = Object.create(null);
    (roster || []).forEach(function (p) { if (p._slot) used[p._slot] = true; });
    return SLOTS.filter(function (s) { return !used[s]; });
  }

  function marginalOvr(roster, player, slot) {
    var before = calculateTeamOvr(roster || []);
    var after = calculateTeamOvr((roster || []).concat([Object.assign({}, player, { _slot: slot })]));
    return round1(after - before);
  }

  function currentActions(roster, pool, opts) {
    opts = opts || {};
    var taken = rosterKeySet(roster, humanKey);
    var open = opts.openPositions || openPositionsForRoster(roster);
    var before = calculateTeamOvr(roster || []), actions = [];
    (pool || []).forEach(function (p) {
      if (taken[humanKey(p)]) return;
      open.forEach(function (slot) {
        if (!canFill(p, slot)) return;
        var cand = Object.assign({}, p, { _slot: slot });
        var ovr = calculateTeamOvr((roster || []).concat([cand]));
        actions.push({
          player: p, slot: slot, ovr: ovr,
          marginal: round1(ovr - before),
          standalone: round1(standardContribution(p))
        });
      });
    });
    actions.sort(function (a, b) { return b.ovr - a.ovr || b.standalone - a.standalone; });
    return actions;
  }

  return {
    WEIGHT: WEIGHT, DENOM: DENOM,
    ERA_BASELINES: ERA_BASELINES, POSITION_WEIGHTS: POSITION_WEIGHTS,
    TEAM_NAMES: TEAM_NAMES, STATS: STATS, SLOTS: SLOTS,
    round1: round1, adjustStat: adjustStat,
    calculateTeamOvr: calculateTeamOvr,
    calculateTeamOvrUnrounded: calculateTeamOvrUnrounded,
    calculateAdjustedOvr: calculateAdjustedOvr,
    playerOvr: playerOvr,
    projectedWins: projectedWins, isPerfect: isPerfect,
    gradeForWins: gradeForWins,
    standardContribution: standardContribution,
    bestPick: bestPick, expectedValuePick: expectedValuePick,
    rankPool: rankPool,
    playerKey: playerKey, humanKey: humanKey,
    canFill: canFill, rosterKeySet: rosterKeySet,
    openPositions: openPositionsForRoster,
    marginalOvr: marginalOvr, currentActions: currentActions
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Solver;
