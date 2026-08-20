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
    set: async obj => Object.assign(store,obj)
  }}
};
global.fetch = async () => { throw new Error('offline test'); };
global.importScripts = (...files) => {
  for (const file of files) {
    const p = path.join(ROOT,file);
    vm.runInThisContext(fs.readFileSync(p,'utf8'), {filename:file});
  }
};
vm.runInThisContext(fs.readFileSync(path.join(ROOT,'background.js'),'utf8'), {filename:'background.js'});
assert(listeners.length, 'background listener not registered');
function send(msg) {
  return new Promise((resolve,reject) => {
    let timer;
    const done = value => { clearTimeout(timer); resolve(value); };
    let kept=false;
    try { kept=listeners[0](msg, {}, done); } catch(e) { reject(e); return; }
    if (kept !== true) { reject(new Error('message channel not kept open')); return; }
    timer=setTimeout(()=>reject(new Error('timeout '+msg.type)), 30000);
  });
}
(async()=>{
  const p = await send({type:'GET_PLAYERS', forceRefresh:false});
  assert.strictEqual(p.source,'bundled');
  assert.strictEqual(p.players.filter(x=>x.era!=='1950s').length,10626);
  const pool=p.players.filter(x=>x.team==='WAS'&&x.era==='2020s');
  const r=await send({type:'SOLVE_PATHS', request:{
    roster:[],currentRoll:{team:'WAS',era:'2020s'},currentPool:pool,
    history:[],strategyMode:'no_skips',simulations:50,beamWidth:2,candidateLimit:9
  }});
  assert(!r.error, r.error);
  assert(r.result.actions.length);
  assert.strictEqual(r.result.actions[0].player.player,'Russell Westbrook');
  console.log('PASS test_background_integration');
})().catch(e=>{console.error(e);process.exit(1)});
