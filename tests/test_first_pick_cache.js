// Regression test for the first-pick (empty roster/history) odds cache in
// background.js. An identical opening-roll request should hit the cache on
// the second call instead of re-running the Monte Carlo solve, while a
// genuinely different roll, or any request with a non-empty roster/history,
// must still solve fresh every time.
//
// Also verifies the specific concern that motivated splitting the cache into
// a picks part and a skips part: switching strategyMode between "no_skips"
// and "compare_skips" (or toggling which skip is available) for the SAME
// opening roll must not re-run the expensive estimatePickActions beam search
// - only the cheap estimateImmediateSkip call should run for whichever skip
// wasn't already cached.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
const listeners = [];
const store = {};

global.self = global;
global.chrome = {
  runtime: {
    getURL: p => p,
    onMessage: { addListener: fn => listeners.push(fn) }
  },
  storage: { local: {
    get: async key => ({[key]: store[key]}),
    set: async obj => Object.assign(store, obj)
  }}
};
global.fetch = async () => { throw new Error('offline test'); };
global.importScripts = (...files) => {
  for (const file of files) {
    const p = path.join(ROOT, file);
    vm.runInThisContext(fs.readFileSync(p, 'utf8'), {filename: file});
  }
};
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), {filename: 'background.js'});
assert(listeners.length, 'background listener not registered');

function send(msg) {
  return new Promise((resolve, reject) => {
    let timer;
    const done = value => { clearTimeout(timer); resolve(value); };
    let kept = false;
    try { kept = listeners[0](msg, {}, done); } catch (e) { reject(e); return; }
    if (kept !== true) { reject(new Error('message channel not kept open')); return; }
    timer = setTimeout(() => reject(new Error('timeout ' + msg.type)), 30000);
  });
}

(async () => {
  await send({type: 'GET_PLAYERS', forceRefresh: false});

  // background.js was loaded via vm.runInThisContext (not require()), so its
  // top-level declarations and the engine it imports attach directly to the
  // shared global, same as this test's own chrome/fetch mocks.
  // Note: solve() calls estimatePickActions/estimateImmediateSkip through its
  // own internal closure reference, not through the exported object, so
  // wrapping the exports below only observes calls solvePaths() makes
  // directly (the first-pick cache-miss path) - it will NOT see calls made
  // via ProbabilityEngine.solve() for non-first-pick requests. solveCalls
  // covers that path instead.
  let pickCalls = 0, skipCalls = 0, solveCalls = 0;
  const realPicks = global.ProbabilityEngine.estimatePickActions;
  const realSkip = global.ProbabilityEngine.estimateImmediateSkip;
  const realSolve = global.ProbabilityEngine.solve;
  global.ProbabilityEngine.estimatePickActions = function (req) {
    pickCalls++;
    return realPicks.call(this, req);
  };
  global.ProbabilityEngine.estimateImmediateSkip = function (req, kind) {
    skipCalls++;
    return realSkip.call(this, req, kind);
  };
  global.ProbabilityEngine.solve = function (req) {
    solveCalls++;
    return realSolve.call(this, req);
  };

  const noSkips = {
    roster: [], currentRoll: {team: 'WAS', era: '2020s'}, history: [],
    strategyMode: 'no_skips', simulations: 50, beamWidth: 2, candidateLimit: 9
  };

  const first = await send({type: 'SOLVE_PATHS', request: noSkips});
  assert(!first.error, first.error);
  assert.strictEqual(pickCalls, 1, 'first request should solve picks');
  assert.strictEqual(skipCalls, 0, 'no_skips mode should never estimate a skip');

  const second = await send({type: 'SOLVE_PATHS', request: Object.assign({}, noSkips)});
  assert(!second.error, second.error);
  assert.strictEqual(pickCalls, 1, 'identical opening roll should hit the picks cache, not re-solve');
  assert.deepStrictEqual(second.result.actions, first.result.actions, 'cached picks should match the original');

  // The key behavior this test guards: switching to compare_skips for the
  // SAME opening roll must reuse the cached picks (no picksCalls increase)
  // and only pay for the two skip estimates, not a full re-solve.
  const compareSkips = Object.assign({}, noSkips, {
    strategyMode: 'compare_skips', teamSkipAvailable: true, decadeSkipAvailable: true
  });
  const third = await send({type: 'SOLVE_PATHS', request: compareSkips});
  assert(!third.error, third.error);
  assert.strictEqual(pickCalls, 1, 'switching to compare_skips must not re-run the expensive picks solve');
  assert.strictEqual(skipCalls, 2, 'compare_skips should estimate both team and decade skips once each');
  assert.deepStrictEqual(third.result.actions, first.result.actions, 'picks should be identical across skip modes');
  assert.strictEqual(third.result.skips.length, 2);

  // Repeating compare_skips for the same roll must hit the skip cache too.
  const fourth = await send({type: 'SOLVE_PATHS', request: Object.assign({}, compareSkips)});
  assert(!fourth.error, fourth.error);
  assert.strictEqual(pickCalls, 1);
  assert.strictEqual(skipCalls, 2, 'repeating compare_skips should hit the skip cache, not re-estimate');

  // A different opening roll must still solve fresh (not silently reuse WAS/2020s).
  const differentEra = Object.assign({}, noSkips, {currentRoll: {team: 'WAS', era: '2010s'}});
  const fifth = await send({type: 'SOLVE_PATHS', request: differentEra});
  assert(!fifth.error, fifth.error);
  assert.strictEqual(pickCalls, 2, 'a different opening roll must still solve fresh');

  // A non-empty roster must never be served from the first-pick cache -
  // solvePaths should fall through to the normal ProbabilityEngine.solve()
  // path every time, not just once for a would-be "warm" entry.
  const withRoster = Object.assign({}, noSkips, {
    roster: [{player: 'Someone', positions: ['PG'], _slot: 'PG'}]
  });
  assert.strictEqual(solveCalls, 0, 'no non-first-pick request has been sent yet');
  const sixth = await send({type: 'SOLVE_PATHS', request: withRoster});
  assert(!sixth.error, sixth.error);
  assert.strictEqual(solveCalls, 1, 'a non-empty roster must go through the normal (uncached) solve path');
  const seventh = await send({type: 'SOLVE_PATHS', request: Object.assign({}, withRoster)});
  assert(!seventh.error, seventh.error);
  assert.strictEqual(solveCalls, 2, 'repeating a non-empty-roster request must solve again, never from the first-pick cache');

  // Key-function sanity, independent of the message-passing plumbing above.
  assert.strictEqual(global.isFirstPick(noSkips), true);
  assert.strictEqual(global.isFirstPick(withRoster), false);
  assert.strictEqual(
    global.isFirstPick(Object.assign({}, noSkips, {history: ['WAS|2020s']})),
    false
  );
  assert.strictEqual(global.firstPickPicksKey(noSkips), 'WAS|2020s|50|2|9');
  // strategyMode/skip flags must NOT appear in the picks key at all - that's
  // the whole point of the split.
  assert.strictEqual(
    global.firstPickPicksKey(noSkips),
    global.firstPickPicksKey(compareSkips),
    'picks key must be identical regardless of skip settings'
  );
  assert.strictEqual(global.firstPickSkipKey(noSkips, 'team'), 'WAS|2020s|80|2|team');

  console.log('PASS test_first_pick_cache');
})().catch(e => { console.error(e); process.exit(1); });
