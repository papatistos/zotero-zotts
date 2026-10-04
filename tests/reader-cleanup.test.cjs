const test=require('node:test');
const assert=require('node:assert/strict');
const esbuild=require('esbuild');
const vm=require('node:vm');
const fs=require('node:fs');
const {load,root}=require('./helpers.cjs');
const config=require('../package.json').config;
test('toolkit reader listeners belong to ZoTTS before construction and disappear on disable/reload',()=>{
 const events=[];
 const Zotero={debug(){},logError(){},Utilities:{randomString:()=> 'fixture'},getMainWindows:()=>[],Reader:{_readers:[],registerEventListener:(type,callback,id)=>events.push({type,callback,id}),_unregisterEventListenerByPluginID:id=>{for(let i=events.length-1;i>=0;i--)if(events[i].id===id)events.splice(i,1);}}};
 const code=esbuild.buildSync({stdin:{contents:'import {BasicTool,KeyboardManager} from "zotero-plugin-toolkit"; globalThis.tools={BasicTool,KeyboardManager};',resolveDir:root},bundle:true,write:false,platform:'browser',format:'iife'}).outputFiles[0].text;
 const ctx={Zotero};vm.runInNewContext(code,ctx);
 // Avoid unrelated plugin-bridge wiring, but execute the pinned KeyboardManager constructor and registration.
 ctx.tools.BasicTool.prototype.addListenerCallback=function(){};
 ctx.tools.BasicTool.prototype.removeListenerCallback=function(){};
 const quiet=class {constructor(base){this.basicOptions=base.basicOptions;} unregisterAll(){}};
 const toolkitExports={...ctx.tools,UITool:quiet,ReaderTool:quiet,FieldHookManager:quiet,unregister:t=>t.Keyboard.unregisterAll()};
 toolkitExports.ZoteroToolkit=class extends ctx.tools.BasicTool {constructor(){super();this.Keyboard=new ctx.tools.KeyboardManager(this);}};
 const imports={'zotero-plugin-toolkit':toolkitExports,'../package.json':{config}};
 if(fs.existsSync(root+'/src/toolkit.ts'))imports['./toolkit']=load('src/toolkit.ts',imports,{Zotero});
 const Addon=load('src/addon.ts',{'zotero-plugin-toolkit':toolkitExports,'./hooks':{default:{}},'./toolkit':imports['./toolkit']},{__env__:'production'}).default;
 // A foreign reader callback must survive both unloads.
 events.push({type:'foreign',id:'foreign-addon'});
 for(let i=0;i<2;i++){
  const addon=new Addon();const own=events.filter(e=>e.type==='renderToolbar');
  assert.equal(own.length,1);assert.equal(own[0].id,config.addonID);
  const listeners=new Set();
  const frame={addEventListener:(type,fn)=>listeners.add(fn),removeEventListener:(type,fn)=>listeners.delete(fn)};
  const reader={_iframeWindow:frame,_internalReader:{_primaryView:{_iframeWindow:frame}}};
  Zotero.Reader._readers.push(reader);
  addon.data.ztoolkit.Keyboard._initKeyboardListener(frame);
  assert.equal(listeners.size,2);
  const closedFrame={addEventListener(){},removeEventListener(){throw new Error('dead reader window');}};
  addon.data.ztoolkit.Keyboard._initKeyboardListener(closedFrame);
  Zotero.Reader._unregisterEventListenerByPluginID(config.addonID);addon.data.ztoolkit.unregisterAll();
  assert.equal(listeners.size,0,'reader DOM keyboard listeners must also be removed');
  addon.data.ztoolkit.Keyboard._initKeyboardListener(frame);
  assert.equal(listeners.size,0,'pending reader initialization cannot attach after unload');
  Zotero.Reader._readers.length=0;
  assert.deepEqual(events.map(e=>e.id),['foreign-addon']);
 }
});
