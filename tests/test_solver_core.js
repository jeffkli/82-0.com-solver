const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
const Solver = require(path.join(ROOT, 'solver-core.js'));

const text = fs.readFileSync(path.join(ROOT, 'data/players.js'), 'utf8');
const m = text.match(/self\.PLAYERS\s*=\s*(\[.*\])\s*;\s*$/s);
assert(m, 'players.js array not found');
const players = JSON.parse(m[1]).filter(p => p.era !== '1950s');
assert.strictEqual(players.length, 10626);

for (const name of [
  'calculateTeamOvr','calculateAdjustedOvr','playerOvr','projectedWins',
  'rankPool','bestPick','expectedValuePick','playerKey'
]) assert.strictEqual(typeof Solver[name], 'function', `missing upstream API ${name}`);

for (const name of ['calculateTeamOvrUnrounded','currentActions','humanKey','isPerfect'])
  assert.strictEqual(typeof Solver[name], 'function', `missing AI API ${name}`);

function find(name, team, era) {
  const p = players.find(x => x.player === name && x.team === team && x.era === era);
  assert(p, `missing ${name} ${team} ${era}`); return p;
}
const roster = [
  Object.assign({}, find('Wilt Chamberlain','GSW','1960s'), {_slot:'C'}),
  Object.assign({}, find('Oscar Robertson','SAC','1960s'), {_slot:'PG'}),
  Object.assign({}, find('Bob Pettit','ATL','1960s'), {_slot:'PF'}),
  Object.assign({}, find('Michael Jordan','CHI','1980s'), {_slot:'SF'}),
  Object.assign({}, find('Dmytro Skapintsev','NYK','2020s'), {_slot:'SG'})
];
assert.strictEqual(Solver.calculateTeamOvr(roster), 118.4);
assert.strictEqual(Solver.projectedWins(118.4), 82);
assert(Solver.calculateAdjustedOvr(roster) > 0);

const west = players.filter(p => p.player === 'Russell Westbrook').slice(0,2);
if (west.length === 2 && west[0].baseSlug && west[1].baseSlug) {
  assert.strictEqual(Solver.humanKey(west[0]), Solver.humanKey(west[1]));
}
console.log('PASS test_solver_core');
