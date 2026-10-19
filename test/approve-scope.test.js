import {test} from 'node:test';import assert from 'node:assert/strict';
import {empty,apply,publicItems,selectSafeCandidates,candidateRisks} from '../src/core.js';
import {createService} from '../src/service.js';
import {fake,history} from './backend.test.js';
// Approval is the user's scope decision: 승인 = public (injected), 비공개로 보관 = unknown.

test('d1e8dba-3 gate kept: a candidate proposed as public is not injected without confirmPublic',()=>{
 const s=apply(empty(),{type:'propose',items:[{id:'p',layer:'elements',text:'PROPOSED',scope:'public'}]});
 assert.throws(()=>apply(s,{type:'approve',ids:['p']}),/공개 범위 확대/);
 assert.throws(()=>apply(s,{type:'approve',ids:['p'],scope:'public'}),/공개 범위 확대/);
 const kept=apply(s,{type:'approve',ids:['p'],scope:'unknown'});
 assert.equal(kept.items[0].scope,'unknown','private approval downgrades a public claim');assert.equal(publicItems(kept).length,0);
 assert.throws(()=>apply(s,{type:'approve',ids:['p'],scope:'secret',confirmPublic:true}),/승인 범위/);
});

test('secret or character candidates are never approved as public; private approval keeps their scope',()=>{
 for(const scope of ['secret','character']){
  const s=apply(empty(),{type:'propose',items:[{id:'s',layer:'anchors',text:'X',scope}]});
  assert.throws(()=>apply(s,{type:'approve',ids:['s'],scope:'public',confirmPublic:true}),/비밀·인물 제한/);
  assert.equal(apply(s,{type:'approve',ids:['s'],scope:'unknown'}).items[0].scope,scope);
 }
});

test('bulk public approval refuses candidates that need a one-by-one look',()=>{
 const s=apply(empty(),{type:'propose',items:[{id:'a',layer:'promises',text:'A',scope:'unknown'},{id:'b',layer:'promises',text:'B',scope:'unknown',status:'completed'}]});
 assert.throws(()=>apply(s,{type:'approve',ids:['a','b'],scope:'public',confirmPublic:true}),/일괄 공개 승인/);
 assert.equal(apply(s,{type:'approve',ids:['b'],scope:'public',confirmPublic:true}).items[0].scope,'public','one-by-one approval stays possible');
 assert.equal(publicItems(apply(s,{type:'approve',ids:['a'],scope:'public',confirmPublic:true})).length,1);
});

test('safe selection takes unknown model candidates and leaves risky ones out',()=>{
 const base={layer:'promises',text:'t',scope:'unknown'};
 const list=[{...base,id:'ok'},{...base,id:'target',targetId:'w'},{...base,id:'hold',hold:true},{...base,id:'review',review:true},{...base,id:'known',knownBy:['a']},{...base,id:'secret',scope:'secret'},{...base,id:'dup',duplicate:true},{...base,id:'done',status:'cancelled'},{...base,id:'branch',branchHold:true},{...base,id:'ok2',scope:'public'}];
 assert.deepEqual(selectSafeCandidates(list),['ok','ok2']);
 assert.deepEqual(candidateRisks(list[1]),['기존 항목 변경']);
});

test('analyze then one-tap approve: the memory is injected into the next reply',async()=>{
 const f=fake();f.grants.add('interceptor');const s=createService(f.a);
 f.a.generate.raw=async()=>({content:'[{"layer":"promises","text":"[이야기 1일차] 공책을 돌려주기로 했다","scope":"public"}]'});
 const analyzed=await s.run({type:'analyze',chatId:'a',revision:0,mode:'raw',connection:'fake',source:{scope:'last',n:2}},'owner');
 const c=analyzed.state.candidates[0];assert.equal(c.scope,'unknown','model scope claims are never trusted');
 // Approval without a scope decision still keeps it out of the prompt.
 const plain=apply(analyzed.state,{type:'approve',ids:[c.id]});assert.equal(publicItems(plain).length,0);
 await assert.rejects(()=>s.run({type:'approve',chatId:'a',revision:1,ids:[c.id],scope:'public'},'owner'),/공개 범위 확대/);
 const approved=await s.run({type:'approve',chatId:'a',revision:1,ids:[c.id],scope:'public',confirmPublic:true},'owner');
 assert.equal(approved.state.items[0].scope,'public');assert.equal(approved.state.candidates.length,0);
 const out=await s.intercept(history('m'),{chatId:'a',userId:'owner'});
 assert.match(out.messages.at(-1).content,/약속: \[이야기 1일차\] 공책을 돌려주기로 했다/);
});

test('private approval is saved but not injected',async()=>{
 const f=fake();f.grants.add('interceptor');const s=createService(f.a);
 const analyzed=await s.run({type:'analyze',chatId:'a',revision:0,mode:'raw',connection:'fake',source:{scope:'last',n:2}},'owner');
 const kept=await s.run({type:'approve',chatId:'a',revision:1,ids:[analyzed.state.candidates[0].id],scope:'unknown'},'owner');
 assert.equal(kept.state.items.length,1);assert.equal(kept.state.items[0].scope,'unknown');
 const messages=history('m'),out=await s.intercept(messages,{chatId:'a',userId:'owner'});assert.equal(out.messages.length,messages.length);
});
