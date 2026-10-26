import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createService} from '../src/service.js';
import {sceneFake,as} from './scene-fake.js';
import {setup} from '../src/frontend.js';
import {diagnose} from '../src/core.js';

// Automatic analysis over several chunks: the failure backoff and the "skipped message"
// warning. Synthetic host and provider only.
const m=(id,size,user=true)=>({id,content:id+'|'+'가'.repeat(size),is_user:user,extra:{}});
async function fixture(messages=[]){
 const f=sceneFake({messages:[]});f.s=createService(f.api,{autoDelayMs:0});
 await as(f.s,{type:'autoSettings',enabled:true,every:3,mode:'raw',connection:'c'});
 f.msgs.a=messages;f.restart=()=>{f.s=createService(f.api,{autoDelayMs:0});};
 f.event=()=>f.s.onGenerationEnded({chatId:'a',messageId:'existing-reply',generationType:'swipe'},'owner');
 f.auto=()=>f.db.get('chats/a/auto.json');
 return f;
}
const sent=f=>f.calls.generate.map(c=>c.messages[1].content);

test('backoff: a failed chunk does not count the user messages that were already waiting behind it',async()=>{
 const f=await fixture(Array.from({length:8},(_,i)=>m('M'+i,40000)));
 f.api.generate.raw=async r=>{f.calls.generate.push(r);if(r.messages[1].content.includes('M1|'))throw Error('provider failed');return {content:'[]'};};
 await f.event();assert.equal(f.calls.generate.length,2);
 assert.equal(f.auto().marker.id,'M0','stored chunk');assert.equal(f.auto().failed.id,'M7','backoff starts after the span the run covered');
 // No new user message: a swipe/regenerate event, even after a restart, sends nothing.
 assert.equal((await f.event()).skip,'backoff');f.restart();assert.equal((await f.event()).skip,'backoff');
 assert.equal(f.calls.generate.length,2);
});

test('backoff: after N new user messages the run resumes at the failed chunk and does not resend stored chunks',async()=>{
 const f=await fixture(Array.from({length:8},(_,i)=>m('M'+i,40000)));
 let failing=true;f.api.generate.raw=async r=>{f.calls.generate.push(r);if(failing&&r.messages[1].content.includes('M1|'))throw Error('provider failed');return {content:'[]'};};
 await f.event();f.restart();
 f.msgs.a.push(m('N0',100),m('N1',100));assert.equal((await f.event()).skip,'backoff','two new messages are fewer than 3');
 f.msgs.a.push(m('N2',100));failing=false;const out=await f.event();assert.equal(out.ok,true);
 const later=sent(f).slice(2);assert.ok(later[0].includes('M1|'),'resumes at the failed chunk');
 assert.ok(!later.some(x=>x.includes('M0|')),'stored chunk is not sent again');
 assert.equal(f.auto().marker.id,'N2');assert.equal(f.auto().failed,null);
});

test('skipped message: the warning survives later successful chunks, a reload and a restart',async()=>{
 const f=await fixture([m('left',40000),m('gap',61000),m('right',40000)]);
 f.api.generate.raw=async r=>{f.calls.generate.push(r);return {content:'[]'};};
 await f.s.autoCheck('a','owner');assert.equal(f.calls.generate.length,2,'the oversized message is never sent');
 assert.ok(!sent(f).some(x=>x.includes('gap|')));assert.equal(f.auto().marker.id,'right');
 assert.deepEqual(f.auto().last.skipped,[2]);assert.equal(f.auto().last.ok,true,'partial success, not a failure');assert.match(f.auto().last.note,/건너뛴 대화 2/);
 f.restart();const panel=await as(f.s,{type:'load'});
 assert.deepEqual(panel.auto.last.skipped,[2]);assert.equal(panel.auto.last.ok,true);
});

test('skipped message: every skipped number of the run is kept, also when a later chunk fails',async()=>{
 const f=await fixture([m('a1',40000),m('big1',61000),m('a2',40000),m('big2',61000),m('a3',40000)]);
 f.api.generate.raw=async r=>{f.calls.generate.push(r);if(r.messages[1].content.includes('a3|'))throw Error('provider failed');return {content:'[]'};};
 await f.s.autoCheck('a','owner');
 const last=f.auto().last;assert.equal(last.ok,false);assert.match(last.error,/provider failed/);assert.deepEqual(last.skipped,[2,4]);
 f.restart();assert.deepEqual((await as(f.s,{type:'load'})).auto.last.skipped,[2,4]);
});

test('skipped message: a run without skips clears the earlier warning; counts add up over chunks',async()=>{
 const f=await fixture([m('left',40000),m('gap',61000),m('right',40000)]);
 f.api.generate.raw=async r=>{f.calls.generate.push(r);return {content:JSON.stringify([{layer:'promises',text:'[이야기 1일차] 약속 '+f.calls.generate.length,scope:'public'}])};};
 await f.s.autoCheck('a','owner');assert.equal(f.auto().last.added,2,'candidates of both chunks, not only the last one');
 f.msgs.a.push(m('u1',100),m('u2',100),m('u3',100));await f.s.autoCheck('a','owner');
 assert.equal(f.auto().last.skipped,undefined);assert.equal(f.auto().last.added,1);
});

test('panel: a partial success shows the skipped message numbers as a warning',()=>{
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);let listener;const sent=[];
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 const state={version:1,revision:0,items:[],candidates:[],undo:[]};
 const last={at:Date.now(),ok:true,added:2,text:'대화 3–3 (1개)',note:'건너뛴 대화 2, 5(메시지 하나가 60,000자 한도 초과 · 잘라 보내지 않음)',error:'',skipped:[2,5]};
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state,auto:{enabled:true,every:3,mode:'raw',connection:'c',last}});
 [...root.querySelectorAll('button')].find(x=>x.textContent==='개요').click();
 const line=root.querySelector('[data-auto]');assert.ok(line);assert.equal(line.dataset.auto,'partial');
 assert.match(line.textContent,/후보 2개/);assert.match(line.textContent,/건너뛴 대화 2, 5/);assert.match(line.textContent,/60,000자/);assert.ok(line.className.includes('lv-warning'));
 cleanup();
});

test('overview diagnostics: a partial success lists the skipped message numbers',()=>{
 const rows=diagnose({items:[],candidates:[]},{last:{ok:true,added:1,skipped:[2,5]}});
 const row=rows.find(x=>x.key==='auto');assert.ok(row);assert.equal(row.tone,'warn');assert.match(row.text,/대화 2, 5/);
 assert.equal(diagnose({items:[],candidates:[]},{last:{ok:true,added:1}}).some(x=>x.key==='auto'),false);
});

test('backoff: messages that arrived during the run, before the failure, are not new messages',async()=>{
 const f=await fixture([m('M0',40000),m('M1',40000),m('M2',40000)]);
 f.api.generate.raw=async r=>{f.calls.generate.push(r);const c=r.messages[1].content;
  if(c.includes('M0|'))f.msgs.a.push(m('D0',100),m('D1',100),m('D2',100));
  if(c.includes('M1|'))throw Error('provider failed');return {content:'[]'};};
 await f.event();assert.equal(f.calls.generate.length,2);
 assert.equal(f.auto().failed.id,'D2','the wait counts from the chat tail at the failure');
 assert.equal((await f.event()).skip,'backoff');f.restart();assert.equal((await f.event()).skip,'backoff');
 assert.equal(f.calls.generate.length,2,'no new message after the failure: nothing is sent again');
 f.msgs.a.push(m('N0',100),m('N1',100),m('N2',100));f.api.generate.raw=async r=>{f.calls.generate.push(r);return {content:'[]'};};
 assert.equal((await f.event()).ok,true);assert.ok(sent(f).slice(2)[0].includes('M1|'),'resumes at the failed chunk');
});

test('skipped message: a skipped last chunk keeps every number and the candidates of the run',async()=>{
 const f=await fixture([m('a1',40000),m('big1',61000),m('a2',40000),m('big2',61000)]);
 f.api.generate.raw=async r=>{f.calls.generate.push(r);return {content:JSON.stringify([{layer:'promises',text:'[이야기 1일차] 약속 '+f.calls.generate.length,scope:'public'}])};};
 await f.s.autoCheck('a','owner');
 const last=f.auto().last;assert.deepEqual(last.skipped,[2,4]);assert.equal(last.added,2,'candidates stored before the skipped last chunk');
 assert.match(last.note,/건너뛴 대화 2, 4/);
 const rows=diagnose({items:[],candidates:[]},{last});const row=rows.find(x=>x.key==='auto');assert.ok(row);assert.match(row.text,/2, 4/);
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);let listener;const out=[];
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>out.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 listener({requestId:out[0].requestId,ok:true,chatId:'a',state:{version:1,revision:0,items:[],candidates:[],undo:[]},auto:{enabled:true,every:3,mode:'raw',connection:'c',last}});
 [...root.querySelectorAll('button')].find(x=>x.textContent==='개요').click();
 const line=root.querySelector('[data-auto]');assert.match(line.textContent,/건너뛴 대화 2, 4/);assert.match(line.textContent,/후보 2개/);
 cleanup();
});
