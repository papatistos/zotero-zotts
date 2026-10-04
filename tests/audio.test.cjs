const test = require('node:test');
const assert = require('node:assert/strict');
const {harness,tick} = require('./audio-harness.cjs');
for(const engine of ['local','openai','kokoro']) {
 test(engine+' playback rejection and media error return idle',async()=>{
  const h=harness(engine),p=new h.mod.Player();await p.initialize();h.audios[0].result=Promise.reject(new Error('denied'));
  await p.playAudio(new Blob(['audio']));await tick();assert.equal(h.addon.data.tts.state,'idle');
  h.audios[0].result=Promise.resolve();await p.playAudio(new Blob(['audio']));
  assert.equal(typeof h.audios[0].onerror,'function');h.audios[0].onerror();assert.equal(h.addon.data.tts.state,'idle');
 });
 test(engine+' stale audio callback cannot finish replacement',async()=>{
  const h=harness(engine),p=new h.mod.Player();let ended=0;p.setOnCompleteCallback(()=>ended++);
  await p.playAudio(new Blob(['old']));const stale=h.audios[0].onended;p.stop();await p.playAudio(new Blob(['new']));stale();
  assert.equal(ended,0);assert.equal(h.addon.data.tts.state,'playing');
 });
 test(engine+' resume rejection is handled',async()=>{
  const h=harness(engine),p=new h.mod.Player();await p.playAudio(new Blob(['audio']));p.pause();h.audios[0].result=Promise.reject(new Error('denied'));p.resume();await tick();assert.equal(h.addon.data.tts.state,'idle');
 });
}
