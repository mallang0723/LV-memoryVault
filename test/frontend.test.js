import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {setup} from '../src/frontend.js';
test('drawer warns near capacity and shows actual retained undo rather than guaranteed 20',()=>{
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div'),sent=[];let listener;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state:{revision:0,items:[],candidates:[],undo:[{items:[],candidates:[]}],padding:'x'.repeat(1850000)}});
 assert.match(root.textContent,/용량 한도 근처/);assert.match(root.textContent,/오래된 되돌리기.*자동/);
 [...root.querySelectorAll('button')].find(x=>x.textContent==='설정').click();
 assert.match(root.textContent,/되돌리기 \(1회 가능\)/);assert.ok(!root.textContent.includes('되돌리기 (20회)'));cleanup();
});
test('drawer forwards approval check and exposes explicit recovery after failed load',()=>{
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div'),sent=[];let listener;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state:{revision:0,items:[],candidates:[]}});
 root.querySelector('[aria-label="공개 범위 확대 확인"]').checked=true;
 [...root.querySelectorAll('button')].find(x=>x.textContent==='선택 승인').click();assert.equal(sent.at(-1).confirmPublic,true);
 [...root.querySelectorAll('button')].find(x=>x.textContent==='새로고침').click();
 listener({requestId:sent.at(-1).requestId,ok:true,chatId:'a',state:null,recovery:true,output:'손상'});
 const button=[...root.querySelectorAll('button')].find(x=>x.textContent==='직전 백업 복원');assert.ok(button);
 button.click();assert.equal(sent.at(-1).type,'restoreBackup');assert.equal(sent.at(-1).confirmRecovery,false);
 root.querySelector('[aria-label="복구 초기화 확인"]').checked=true;button.click();assert.equal(sent.at(-1).confirmRecovery,true);cleanup();
});
test('drawer safe text, A-B-A stale isolation and cleanup at desktop/360 structure',()=>{
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);const sent=[];let listener,switcher,removed=0;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy:()=>{root.remove();removed++;}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>removed++;},events:{on:(_,fn)=>{switcher=fn;return()=>removed++;}}});
 const reply=(r,text)=>listener({requestId:r.requestId,ok:true,chatId:'a',state:{revision:0,items:[{id:'i',layer:'elements',text,scope:'public',evidence:[]}],candidates:[]}});
 const first=sent[0];switcher({chatId:'b'});switcher({chatId:'a'});reply(sent.at(-1),'<img src=x onerror=alert(1)>');reply(first,'STALE');
 assert.ok(root.textContent.includes('<img'));assert.ok(!root.textContent.includes('STALE'));assert.equal(root.querySelectorAll('img').length,0);
 assert.ok(root.querySelector('style').textContent.includes('360px'));cleanup();assert.equal(removed,3);reply(sent.at(-1),'after cleanup');assert.equal(document.body.children.length,0);
});
test('newer error cannot hide older successful persisted state',()=>{
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div'),sent=[];let listener;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 root.querySelector('button').click();
 listener({requestId:sent[1].requestId,ok:false,error:'newer error'});
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state:{revision:1,items:[{id:'x',layer:'elements',text:'PERSISTED',scope:'public'}],candidates:[]}});
 assert.match(root.textContent,/PERSISTED/);cleanup();
});
