import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {uuid} from '../src/core.js';
import {setup} from '../src/frontend.js';

// Plain http on a non-localhost address (a phone reaching the PC over Tailscale) is not a secure context:
// crypto.randomUUID is missing there. Shadow the prototype method on the instance so it is really gone
// (delete on the instance does not remove the prototype method), and always restore it: tests share one process.
const V4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function withoutWebCrypto(names,fn){
 const c=globalThis.crypto;
 for(const n of names)Object.defineProperty(c,n,{value:undefined,configurable:true,writable:true});
 try{for(const n of names)assert.notEqual(typeof c[n],'function',n+' still callable');return await fn();}
 finally{for(const n of names)delete c[n];}
}

test('insecure context: without crypto.randomUUID the drawer still sends requests and opens the editor',async()=>{
 await withoutWebCrypto(['randomUUID'],()=>{
  const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
  const root=document.createElement('div'),sent=[];let listener;
  const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
  assert.equal(sent[0].type,'load');assert.match(sent[0].requestId,V4);
  listener({requestId:sent[0].requestId,ok:true,chatId:'a',state:{revision:0,items:[],candidates:[],undo:[]}});
  [...root.querySelectorAll('button')].find(x=>x.textContent==='새로고침').click();
  assert.match(sent.at(-1).requestId,V4);
  assert.equal(new Set(sent.map(r=>r.requestId)).size,sent.length);
  cleanup();
 });
 assert.equal(typeof crypto.randomUUID,'function','restored');
});

test('id fallbacks: getRandomValues, then Math.random, both give RFC 4122 v4 strings',async()=>{
 await withoutWebCrypto(['randomUUID'],()=>{const ids=Array.from({length:200},uuid);for(const id of ids)assert.match(id,V4);assert.equal(new Set(ids).size,ids.length);});
 await withoutWebCrypto(['randomUUID','getRandomValues'],()=>{const ids=Array.from({length:200},uuid);for(const id of ids)assert.match(id,V4);assert.equal(new Set(ids).size,ids.length);});
 assert.match(uuid(),V4);
});

test('browser code makes ids only through the fallback helper',()=>{
 for(const f of ['src/view.js','src/frontend.js','src/scene-view.js','src/vault-style.js','src/chronicle.js'])assert.ok(!readFileSync(f,'utf8').includes('crypto.randomUUID'),f);
 const panel=readFileSync('dist/frontend.js','utf8');
 const calls=panel.match(/\brandomUUID\(\)/g)||[];
 assert.equal(calls.length,1,'only the guarded call inside uuid()');
 assert.match(panel,/if\(typeof c\?\.randomUUID==='function'\)return c\.randomUUID\(\);/);
 assert.ok(!/\bcrypto\.randomUUID\(\)/.test(panel));
});
