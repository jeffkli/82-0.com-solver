const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
global.Solver = require(path.join(ROOT, 'solver-core.js'));
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'probability-core.js'),'utf8'), {filename:'probability-core.js'});
const text = fs.readFileSync(path.join(ROOT, 'data/players.js'), 'utf8');
const players = JSON.parse(text.match(/self\.PLAYERS\s*=\s*(\[.*\])\s*;\s*$/s)[1]).filter(p=>p.era!=='1950s');
ProbabilityEngine.init(players);
assert.strictEqual(ProbabilityEngine.getStats().players, 10626);
assert.strictEqual(ProbabilityEngine.getStats().pools, 180);
const pool = players.filter(p=>p.team==='WAS' && p.era==='2020s');
const result = ProbabilityEngine.solve({
  roster: [], currentRoll:{team:'WAS',era:'2020s'}, currentPool:pool,
  history:[], strategyMode:'no_skips', simulations:50, beamWidth:2, candidateLimit:9
});
assert(result.actions.length > 0);
assert.strictEqual(result.actions[0].player.player, 'Russell Westbrook');
assert.strictEqual(result.actions[0].slot, 'PG');
assert(result.actions[0].probability >= 0 && result.actions[0].probability <= 1);
console.log('PASS test_probability_core', result.actions[0].probability);
