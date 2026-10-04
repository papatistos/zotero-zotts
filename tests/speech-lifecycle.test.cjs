const test=require('node:test');
const assert=require('node:assert/strict');
const {load,prefs}=require('./helpers.cjs');
function harness(platform){
 const utterances=[];const addon={data:{tts:{state:'idle',engines:{webSpeech:{extras:{linuxQueue:[]}}}}}};
 const module=load('src/modules/tts/webspeech.ts',{'../utils/prefs':prefs({newItemBehaviour:'cancel','webSpeech.voice':'voice'}),'../utils/wait':{}},{addon,Zotero:{isMac:platform==='mac',isWin:platform==='win',isLinux:platform==='linux'},window:{SpeechSynthesisUtterance:class {},speechSynthesis:{getVoices:()=>[{name:'voice'}],cancel(){},speak:utt=>utterances.push(utt)}}});
 return {module,addon,utterances};
}
for(const platform of ['mac','win','linux']) {
 test('Web Speech stop returns idle on '+platform,()=>{
  const h=harness(platform);h.module.speak('old');h.utterances[0].onstart();h.module.stop();assert.equal(h.addon.data.tts.state,'idle');
 });
 test('Web Speech error returns idle and ignores cancelled callbacks on '+platform,()=>{
  const h=harness(platform);h.module.speak('old');const old=h.utterances[0];old.onstart();assert.equal(typeof old.onerror,'function');old.onerror({error:'audio-busy'});assert.equal(h.addon.data.tts.state,'idle');
  h.module.speak('new');const current=h.utterances.at(-1);current.onstart();old.onerror({error:'canceled'});old.onend();old.onpause();assert.equal(h.addon.data.tts.state,'playing');
  current.onerror({error:'interrupted'});assert.equal(h.addon.data.tts.state,'idle');
 });
}
