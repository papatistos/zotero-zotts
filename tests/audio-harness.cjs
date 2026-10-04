const test = require('node:test');
const assert = require('node:assert/strict');
const {load, prefs} = require('./helpers.cjs');
const tick = async () => {for(let i=0;i<12;i++) await Promise.resolve();};
function deferred() {let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function harness(engine) {
 const requests=[], audios=[], played=[], revoked=[];
 const addon={data:{tts:{state:'idle'}}};
 class Audio {constructor(){audios.push(this);} pause(){} removeAttribute(){} load(){} play(){played.push(this.src); return this.result || Promise.resolve();}}
 let url=0;
 const imports={'../utils/prefs':prefs({[engine+'.apiUrl']:'http://fixture.invalid',[engine+'.apiKey']:'fixture',[engine+'.voice']:'alloy',[engine+'.volume']:100,[engine+'.rate']:100}), '../utils/notify':{notifyGeneric(){}},'../utils/locale':{getString:x=>x}, '../utils/audioCue':{playQueuedSpeechCue(){}}};
 const mod=load('src/modules/tts/'+engine+'.ts',imports,{window:{Audio,AbortController},addon,Error,Blob,URL:{createObjectURL:b=>{played.blobs??=[];played.blobs.push(b);return 'blob:'+ ++url;},revokeObjectURL:u=>revoked.push(u)},fetch:(url, options)=>{const d=deferred();requests.push({...d,options});return d.promise;},ztoolkit:{log(){}}},`exports.Synth = ${engine==='openai'?'OpenAI':engine==='local'?'Local':'Kokoro'}Synthesizer; exports.Player = AudioPlayer;`);
 return {mod,addon,requests,audios,played,revoked,resolve(i,text='audio'){requests[i].resolve({ok:true,blob:async()=>new Blob([text])});}};
}

module.exports = {harness,tick};
