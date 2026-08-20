/*
 * Probability engine for the AI overlay.
 *
 * Metric: projected probability that the remaining accepted team-era rolls
 * admit at least one legal 82-0 completion, given the current pick. Future
 * player choices are optimized with full knowledge of the sampled future rolls,
 * so this is an "oracle path / solvability" estimate rather than a guarantee
 * that a causal human policy will attain the same rate.
 *
 * Roll rule: accepted team-era cells are sampled uniformly, but any cell that
 * has already appeared twice is excluded from future accepted rolls.
 */
var ProbabilityEngine = (function () {
  "use strict";

  var players = [];
  var byPool = Object.create(null);
  var poolKeys = [];
  var poolsByEra = Object.create(null);
  var poolsByTeam = Object.create(null);
  var slotCandidates = Object.create(null);
  var maxStandalone = Object.create(null);

  function poolKey(team, era) { return team + "|" + era; }

  function normalizePlayer(p) {
    return Object.assign({}, p, {
      ppg: Number(p.ppg) || 0,
      rpg: Number(p.rpg) || 0,
      apg: Number(p.apg) || 0,
      spg: Number(p.spg) || 0,
      bpg: Number(p.bpg) || 0,
      positions: Array.isArray(p.positions) ? p.positions : []
    });
  }

  function init(rawPlayers) {
    players = (rawPlayers || [])
      .filter(function (p) { return p && p.era !== "1950s"; })
      .map(normalizePlayer);

    byPool = Object.create(null);
    poolsByEra = Object.create(null);
    poolsByTeam = Object.create(null);

    players.forEach(function (p) {
      var k = poolKey(p.team, p.era);
      (byPool[k] || (byPool[k] = [])).push(p);
    });

    poolKeys = Object.keys(byPool).sort();
    poolKeys.forEach(function (k) {
      var parts = k.split("|");
      var team = parts[0], era = parts[1];
      (poolsByEra[era] || (poolsByEra[era] = [])).push(k);
      (poolsByTeam[team] || (poolsByTeam[team] = [])).push(k);
    });

    buildCandidateCache();
  }

  function sortTop(list, fn, n) {
    return list.slice().sort(function (a, b) { return fn(b) - fn(a); }).slice(0, n);
  }

  function buildCandidateCache() {
    slotCandidates = Object.create(null);
    maxStandalone = Object.create(null);

    poolKeys.forEach(function (k) {
      slotCandidates[k] = Object.create(null);
      maxStandalone[k] = Object.create(null);

      Solver.SLOTS.forEach(function (slot) {
        var eligible = (byPool[k] || []).filter(function (p) {
          return Solver.canFill(p, slot);
        });
        if (!eligible.length) {
          slotCandidates[k][slot] = [];
          maxStandalone[k][slot] = -Infinity;
          return;
        }

        // Union several top lists. This protects against the Classic formula's
        // strange defensive denominator: pure offense, steals, blocks, boards,
        // and assists can each matter differently depending on the roster.
        var seen = Object.create(null), out = [];
        function add(list) {
          list.forEach(function (p) {
            var id = (Solver.humanKey ? Solver.humanKey(p) : Solver.playerKey(p));
            if (!seen[id]) { seen[id] = true; out.push(p); }
          });
        }
        var offense = function (p) {
          return (p.ppg || 0) * 0.3448275862 +
                 (p.rpg || 0) * 0.6297229219 +
                 (p.apg || 0) * 0.6143344710;
        };
        add(sortTop(eligible, Solver.standardContribution, 10));
        add(sortTop(eligible, offense, 6));
        add(sortTop(eligible, function (p) { return p.rpg || 0; }, 4));
        add(sortTop(eligible, function (p) { return p.apg || 0; }, 4));
        add(sortTop(eligible, function (p) { return p.spg || 0; }, 4));
        add(sortTop(eligible, function (p) { return p.bpg || 0; }, 4));

        slotCandidates[k][slot] = out.slice(0, 24);
        maxStandalone[k][slot] = Math.max.apply(
          null, eligible.map(Solver.standardContribution)
        );
      });
    });
  }

  function hashString(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function rngFromSeed(seed) {
    var x = (seed >>> 0) || 0x9e3779b9;
    return function () {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      return (x >>> 0) / 4294967296;
    };
  }

  function countRolls(history) {
    var counts = Object.create(null);
    (history || []).forEach(function (k) {
      counts[k] = (counts[k] || 0) + 1;
    });
    return counts;
  }

  function cloneCounts(c) {
    var out = Object.create(null);
    Object.keys(c).forEach(function (k) { out[k] = c[k]; });
    return out;
  }

  function allowedFrom(list, counts) {
    return list.filter(function (k) { return (counts[k] || 0) < 2; });
  }

  function sampleOne(list, counts, rng) {
    var allowed = allowedFrom(list, counts);
    if (!allowed.length) return null;
    return allowed[Math.floor(rng() * allowed.length)];
  }

  function sampleFutureSequence(rounds, counts, rng) {
    var c = cloneCounts(counts), seq = [];
    for (var i = 0; i < rounds; i++) {
      var k = sampleOne(poolKeys, c, rng);
      if (!k) return null;
      seq.push(k);
      c[k] = (c[k] || 0) + 1;
    }
    return seq;
  }

  function exactOneRoundScenarios(counts) {
    return allowedFrom(poolKeys, counts).map(function (k) { return [k]; });
  }

  function rosterStateKey(roster) {
    return roster.slice().sort(function (a, b) {
      return Solver.SLOTS.indexOf(a._slot) - Solver.SLOTS.indexOf(b._slot);
    }).map(function (p) {
      return p._slot + ":" + (Solver.humanKey ? Solver.humanKey(p) : Solver.playerKey(p));
    }).join(",");
  }

  function optimisticAssignment(openSlots, remainingPools) {
    if (!remainingPools.length) return 0;
    var memo = Object.create(null);

    function rec(i, slots) {
      if (i >= remainingPools.length) return 0;
      var key = i + "|" + slots.slice().sort().join(",");
      if (memo[key] != null) return memo[key];

      var pk = remainingPools[i], best = -Infinity;
      for (var j = 0; j < slots.length; j++) {
        var slot = slots[j], v = maxStandalone[pk][slot];
        if (!Number.isFinite(v)) continue;
        var next = slots.slice();
        next.splice(j, 1);
        best = Math.max(best, v + rec(i + 1, next));
      }
      memo[key] = Number.isFinite(best) ? best : -1e9;
      return memo[key];
    }
    return rec(0, openSlots);
  }

  function bestCompletionScore(initialRoster, sequence, beamWidth) {
    var beam = [{
      roster: initialRoster.slice(),
      open: Solver.openPositions(initialRoster),
      score: Solver.calculateTeamOvr(initialRoster)
    }];

    for (var step = 0; step < sequence.length; step++) {
      var pk = sequence[step];
      var remainingPools = sequence.slice(step + 1);
      var nextMap = Object.create(null);

      for (var bi = 0; bi < beam.length; bi++) {
        var st = beam[bi];
        var taken = Solver.rosterKeySet(st.roster);

        for (var si = 0; si < st.open.length; si++) {
          var slot = st.open[si];
          var cands = (slotCandidates[pk] && slotCandidates[pk][slot]) || [];

          for (var pi = 0; pi < cands.length; pi++) {
            var p = cands[pi];
            if (taken[(Solver.humanKey ? Solver.humanKey(p) : Solver.playerKey(p))]) continue;

            var cand = Object.assign({}, p, { _slot: slot });
            var nr = st.roster.concat([cand]);
            var no = st.open.slice();
            no.splice(si, 1);
            var sc = Solver.calculateTeamOvr(nr);
            var priority = sc + 0.65 * Math.max(0, optimisticAssignment(no, remainingPools));
            var key = rosterStateKey(nr);
            var prev = nextMap[key];

            if (!prev || priority > prev.priority) {
              nextMap[key] = { roster: nr, open: no, score: sc, priority: priority };
            }
          }
        }
      }

      var next = Object.keys(nextMap).map(function (k) { return nextMap[k]; });
      if (!next.length) return -Infinity;
      next.sort(function (a, b) {
        return b.priority - a.priority || b.score - a.score;
      });
      beam = next.slice(0, beamWidth);
    }

    var best = -Infinity;
    for (var i = 0; i < beam.length; i++) {
      if (beam[i].roster.length !== 5) continue;
      best = Math.max(best, Solver.calculateTeamOvr(beam[i].roster));
    }
    return best;
  }

  function sequenceCanPerfect(roster, sequence, beamWidth) {
    return bestCompletionScore(roster, sequence, beamWidth) >= 109.5;
  }

  function pruneCurrentActions(roster, pool, limit) {
    var all = Solver.currentActions(roster, pool);
    if (all.length <= limit) return all;

    var seen = Object.create(null), out = [];
    function add(a) {
      var key = (Solver.humanKey ? Solver.humanKey(a.player) : Solver.playerKey(a.player)) + "|" + a.slot;
      if (!seen[key]) { seen[key] = true; out.push(a); }
    }

    // Preserve strong choices for every still-open position.
    Solver.openPositions(roster).forEach(function (slot) {
      all.filter(function (a) { return a.slot === slot; }).slice(0, 4).forEach(add);
    });
    all.slice(0, limit).forEach(add);
    out.sort(function (a, b) { return b.ovr - a.ovr; });
    return out.slice(0, Math.max(limit, 8));
  }

  function stateSeed(roster, currentKey, history, extra) {
    return hashString(
      rosterStateKey(roster) + "|" + currentKey + "|" +
      (history || []).join(",") + "|" + (extra || "")
    );
  }

  function estimatePickActions(req) {
    var currentKey = poolKey(req.currentRoll.team, req.currentRoll.era);
    var pool = byPool[currentKey] || [];
    var roster = (req.roster || []).map(normalizePlayer);
    var history = (req.history || []).slice();
    var candidateLimit = req.candidateLimit || 14;
    var beamWidth = req.beamWidth || 90;
    var simulations = req.simulations || 600;
    var actions = pruneCurrentActions(roster, pool, candidateLimit);
    var futureRounds = 5 - roster.length - 1;
    var counts = countRolls(history.concat([currentKey]));
    var exact = futureRounds <= 1;
    var scenarios;

    if (futureRounds < 0) return { actions: [], scenarios: 0, exact: true };

    if (futureRounds === 0) {
      scenarios = [[]];
    } else if (futureRounds === 1) {
      scenarios = exactOneRoundScenarios(counts);
    } else {
      var rng = rngFromSeed(stateSeed(roster, currentKey, history, "pick"));
      scenarios = [];
      for (var s = 0; s < simulations; s++) {
        var seq = sampleFutureSequence(futureRounds, counts, rng);
        if (seq) scenarios.push(seq);
      }
    }

    var results = actions.map(function (a) {
      var picked = Object.assign({}, a.player, { _slot: a.slot });
      var nr = roster.concat([picked]);
      var wins = 0;

      for (var s = 0; s < scenarios.length; s++) {
        if (sequenceCanPerfect(nr, scenarios[s], beamWidth)) wins++;
      }

      var p = scenarios.length ? wins / scenarios.length : 0;
      var se = exact || !scenarios.length ? 0 :
        Math.sqrt(Math.max(p * (1 - p), 0) / scenarios.length);

      return {
        type: "pick",
        player: a.player,
        slot: a.slot,
        probability: p,
        standardError: se,
        immediateOvr: a.ovr,
        marginalOvr: a.marginal,
        standaloneOvr: a.standalone,
        successes: wins,
        scenarios: scenarios.length,
        exact: exact
      };
    });

    results.sort(function (a, b) {
      return b.probability - a.probability ||
             b.immediateOvr - a.immediateOvr ||
             b.standaloneOvr - a.standaloneOvr;
    });

    return { actions: results, scenarios: scenarios.length, exact: exact };
  }

  function estimateImmediateSkip(req, kind) {
    var roster = (req.roster || []).map(normalizePlayer);
    var history = (req.history || []).slice();
    var futureRounds = 5 - roster.length - 1;
    var simulations = Math.max(80, Math.floor((req.simulations || 600) * 0.55));
    var beamWidth = req.beamWidth || 90;
    var priorCounts = countRolls(history);
    var baseList = kind === "team"
      ? (poolsByEra[req.currentRoll.era] || [])
      : (poolsByTeam[req.currentRoll.team] || []);
    if (!baseList.length) return null;

    var rng = rngFromSeed(stateSeed(
      roster,
      poolKey(req.currentRoll.team, req.currentRoll.era),
      history,
      "skip-" + kind
    ));

    var successes = 0, valid = 0;
    for (var s = 0; s < simulations; s++) {
      var counts = cloneCounts(priorCounts);
      var rerolled = sampleOne(baseList, counts, rng);
      if (!rerolled) continue;
      counts[rerolled] = (counts[rerolled] || 0) + 1;

      var future = sampleFutureSequence(futureRounds, counts, rng);
      if (!future) continue;
      valid++;

      // Rerolled current pool is the first accepted pick. This optimizes that
      // pick and all future picks for the sampled sequence.
      if (sequenceCanPerfect(roster, [rerolled].concat(future), beamWidth)) {
        successes++;
      }
    }

    var p = valid ? successes / valid : 0;
    return {
      type: kind === "team" ? "team_skip" : "decade_skip",
      probability: p,
      standardError: valid ? Math.sqrt(Math.max(p * (1 - p), 0) / valid) : 0,
      successes: successes,
      scenarios: valid,
      exact: false
    };
  }

  function solve(req) {
    var picks = estimatePickActions(req);
    var skips = [];

    if (req.strategyMode === "compare_skips") {
      if (req.teamSkipAvailable !== false) {
        var ts = estimateImmediateSkip(req, "team");
        if (ts) skips.push(ts);
      }
      if (req.decadeSkipAvailable !== false) {
        var ds = estimateImmediateSkip(req, "decade");
        if (ds) skips.push(ds);
      }
      skips.sort(function (a, b) { return b.probability - a.probability; });
    }

    return {
      actions: picks.actions,
      skips: skips,
      scenarios: picks.scenarios,
      exact: picks.exact,
      model: "oracle_path",
      maxRepeat: 2
    };
  }

  return {
    init: init,
    solve: solve,
    bestCompletionScore: bestCompletionScore,
    getStats: function () { return { players: players.length, pools: poolKeys.length }; }
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = ProbabilityEngine;
}
