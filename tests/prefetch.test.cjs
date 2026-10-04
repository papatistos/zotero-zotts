const test = require('node:test');
const assert = require('node:assert/strict');
const {harness,tick} = require('./audio-harness.cjs');
for(const engine of ['local','openai']) {
 test(engine+' preserves document order and waits for pending prefetch',async()=>{
  const h=harness(engine), s=new h.mod.Synth();
  const speaking=s.speak('x'.repeat(1500)); await tick();
  const first=h.requests.findIndex(r=>JSON.parse(r.options.body).input.length===250);
  h.resolve(first,'first'); await speaking;
  const pending=h.requests.map((r,i)=>i).filter(i=>i!==first);
  assert.equal(pending.length,2);
  h.resolve(pending[1],'third'); await tick();
  h.audios[0].onended(); await tick();
  assert.equal(h.played.length,1,'third must not overtake second');
  assert.notEqual(h.addon.data.tts.state,'idle','pending prefetch is not completion');
  h.resolve(pending[0],'second'); await tick();
  assert.equal(h.played.length,2);
  assert.equal(await h.played.blobs[1].text(),'second');
  h.audios[0].onended(); await tick();
  assert.equal(await h.played.blobs[2].text(),'third');
 });
 for(const action of ['stop','dispose','replace']) test(engine+' '+action+' aborts every request and rejects stale results',async()=>{
  const h=harness(engine),s=new h.mod.Synth(); const old=s.speak('x'.repeat(1500));await tick(); const oldCount=h.requests.length;
  let next; if(action==='replace') next=s.speak('new');else s[action](); await tick();
  assert.ok(h.requests.slice(0,oldCount).every(r=>r.options.signal.aborted));
  for(let i=0;i<oldCount;i++)h.resolve(i,'old');await old;await tick();
  assert.equal(h.played.length,0);
  assert.equal(s.audioQueue.length,0);
  if(next){h.resolve(oldCount,'new');await next;assert.equal(await s.sessionCache.sections[0].text(),'new');}
 });
 test(engine+' prefetch failure ends safely without skipping text',async()=>{
  const h=harness(engine),s=new h.mod.Synth();const run=s.speak('x'.repeat(1500));await tick();
  const first=h.requests.findIndex(r=>JSON.parse(r.options.body).input.length===250);h.resolve(first);await run;
  h.audios[0].onended();await tick();h.requests.find((r,i)=>i!==first).reject(new Error('failed'));await tick();
  assert.equal(h.addon.data.tts.state,'idle');
 });
}
