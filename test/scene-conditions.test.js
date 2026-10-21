import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {sceneFake,makeMessages,rec,approveLast,as} from './scene-fake.js';
// 0.4.2 regressions, run against both the source modules and the built dist bundles:
// a node narrowed below public withdraws every chapter above it (C12), hidden source
// turns follow actual injection (C13), scene/book delete confirmations are bound to the
// revision and book they were opened for (C14), and settings changed while the attempt
// receipt is being written send nothing (C6-R1).
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const targets=[
 ['source',()=>import('../src/service.js'),()=>import('../src/chronicle.js'),()=>import('../src/frontend.js')],
 ['dist',()=>import('../dist/backend.js'),()=>import('../dist/backend.js'),()=>import('../dist/frontend.js')]
];
for(const [target,loadService,loadChronicle,loadFrontend] of targets){
 const {createService}=await loadService(),{sceneEvaluate,scenePlan,sceneEmpty}=await loadChronicle(),{setup}=await loadFrontend();
 const svc=f=>createService(f.api,{autoDelayMs:1});
 const load=async s=>(await as(s,{type:'sceneLoad'})).chronicle;
 const request=async(s,r)=>{const v=await load(s);return as(s,{...r,sceneRevision:v.revision});};
 const scenes=async(s,ranges)=>{for(const [a,b] of ranges){await rec(s,a,b);await approveLast(s);}};
 const merge=async(s,ids)=>{await request(s,{type:'sceneMerge',ids,mode:'raw',connection:'conn'});return (await approveLast(s)).chronicle;};
 const active=f=>[...f.entries.values()].filter(e=>!e.disabled);
 const hidden=f=>f.msgs.a.filter(m=>m.extra?.hidden).map(m=>m.id);
 const guard=(s,f,entries)=>s.worldInfoGuard({chatId:'a',userId:'owner',messages:f.msgs.a,entries});

 // ---- C12: narrowing a node withdraws every chapter that carries it ----
 for(const scope of ['secret','unknown'])test(target+' C12 archived scene public→'+scope+' under a two-level merge: no chapter entry left, guard blocks, our hidden turns return, no model call',async()=>{
  const f=sceneFake({messages:makeMessages(60)}),s=svc(f);await scenes(s,[[1,10],[11,20],[21,30]]);
  let v=await load(s);const leaf=v.nodes[0];v=await merge(s,v.nodes.slice(0,2).map(n=>n.id));
  const inner=v.nodes.find(n=>n.kind==='chapter');v=await merge(s,[inner.id,v.nodes.find(n=>n.label==='장면 21–30').id]);
  const top=v.nodes.find(n=>n.label==='장 1–30');
  await request(s,{type:'sceneSettings',autoHide:true});assert.equal(hidden(f).length,30);
  const before=active(f);assert.deepEqual(before.map(e=>e.comment),['장 1–30']);
  const calls=f.calls.generate.length,leafRevision=v.nodes.find(n=>n.id===leaf.id).revision;
  v=(await request(s,{type:'sceneEdit',id:leaf.id,scope})).chronicle;
  const now=id=>v.nodes.find(n=>n.id===id);
  assert.equal(now(leaf.id).scope,scope);assert.equal(now(leaf.id).revision,leafRevision+1,'scope change bumps the revision');
  assert.equal(now(top.id).state,'stale');assert.equal(now(top.id).mode,'none');assert.equal(now(inner.id).mode,'none');assert.equal(now(leaf.id).mode,'none');
  assert.equal(active(f).length,0,'nothing above the narrowed scene is injected');
  for(const id of [top.id,inner.id,leaf.id])assert.ok(![...f.entries.values()].some(e=>e.extensions?.memory_cabinet?.nodeId===id),'no entry left for '+id);
  const g=await guard(s,f,before);assert.deepEqual(g?.disabled,before.map(e=>e.id),'guard blocks the old chapter entry');
  assert.equal(hidden(f).length,0,'turns we hid come back');assert.equal(f.calls.generate.length,calls,'no model call');
  // The chapter is undone (no call): the inner chapter stays out, the untouched public scene comes back.
  v=(await request(s,{type:'sceneUnmerge',id:top.id})).chronicle;
  assert.equal(now(inner.id).mode,'none');assert.deepEqual(active(f).map(e=>e.comment),['장면 21–30']);assert.equal(f.calls.generate.length,calls);
 });
 test(target+' C12 a stored chapter over a narrowed child with an unchanged revision (0.4.0 data) is stale and has no entry',async()=>{
  const msgs=Array.from({length:30},(_,i)=>({id:'m'+(i+1),digest:'sha256:'+String(i).padStart(64,'0'),hidden:false}));
  const s=sceneEmpty(),node=(id,a,b,extra={})=>({id,kind:'scene',title:'',body:'[이야기 1일차] 본문',keywords:['민수'],scope:'public',status:'approved',revision:1,range:{ids:msgs.slice(a-1,b).map(m=>m.id),fps:msgs.slice(a-1,b).map(m=>m.digest),start:a,end:b},parentId:'',generation:null,entry:null,entryEdited:false,at:0,...extra});
  s.nodes.push(node('a',1,10,{parentId:'A',scope:'secret'}),node('b',11,20,{parentId:'A'}),node('c',21,30,{parentId:'B'}));
  s.nodes.push({...node('A',1,20,{parentId:'B'}),kind:'chapter',children:[{id:'a',revision:1},{id:'b',revision:1}]});
  s.nodes.push({...node('B',1,30),kind:'chapter',children:[{id:'A',revision:1},{id:'c',revision:1}]});
  const ev=sceneEvaluate(s,msgs),p=scenePlan(s,ev);
  assert.equal(ev.get('B').state,'stale');assert.equal(ev.get('B').reason,'scope');
  assert.equal(p.plan.get('B'),'none');assert.equal(p.plan.get('A'),'none');assert.deepEqual(p.constantIds,[]);
 });

 // ---- C13: hidden turns follow actual injection ----
 for(const action of ['detach','delete'])test(target+' C13 '+action+' returns exactly the turns we hid; the user\'s own hidden turn stays; re-attaching hides again',async()=>{
  const f=sceneFake({messages:makeMessages(60)}),s=svc(f);f.msgs.a[2].extra.hidden=true;await scenes(s,[[1,20]]);
  await request(s,{type:'sceneSettings',autoHide:true});assert.equal(hidden(f).length,20);
  const entry=active(f)[0],book=(await load(s)).book;
  const out=await request(s,{type:'sceneBook',action,...(action==='delete'?{confirm:true,bookRef:book.ref}:{})});
  assert.equal(out.chronicle.settings.inject,false);assert.deepEqual(f.meta.a.chat_world_book_ids,[]);
  assert.deepEqual(hidden(f),['m3'],'ours unhidden, the user-hidden m3 untouched');assert.equal(out.chronicle.hidden,0);
  assert.ok(!f.calls.hidden.some(c=>c.ids.includes('m3')),'never touched the user-hidden turn');
  await as(s,{type:'sceneSync'});assert.deepEqual(hidden(f),['m3'],'later syncs hide nothing');
  assert.deepEqual((await guard(s,f,[entry]))?.disabled,[entry.id],'guard: injection off blocks a left-over entry');
  await request(s,{type:'sceneBook',action:'attach'});
  assert.equal(hidden(f).length,20);assert.equal(f.meta.a.chat_world_book_ids.length,1);assert.equal(active(f).length,1);
 });
 for(const action of ['detach','delete'])test(target+' C13 auto-hide turned on after '+action+' hides nothing new',async()=>{
  const f=sceneFake({messages:makeMessages(60)}),s=svc(f);await scenes(s,[[1,20]]);
  const book=(await load(s)).book;
  await request(s,{type:'sceneBook',action,...(action==='delete'?{confirm:true,bookRef:book.ref}:{})});
  const out=await request(s,{type:'sceneSettings',autoHide:true});
  assert.equal(hidden(f).length,0,'no new hidden turn while not injected');assert.ok(!f.calls.hidden.some(c=>c.hidden));
  assert.equal(out.chronicle.settings.autoHide,true);assert.match(out.notice,/숨기지 않습니다/);
 });

 // ---- C14: delete confirmations bound to their revision and book ----
 test(target+' C14 service rejects a scene delete or book delete for another revision or another book',async()=>{
  const f=sceneFake({messages:makeMessages(60)}),s=svc(f);await scenes(s,[[1,20],[21,40]]);
  const v=await load(s),n=v.nodes[0];
  await assert.rejects(as(s,{type:'sceneDelete',id:n.id,sceneRevision:v.revision-1}),/바뀌었습니다/);
  await assert.rejects(as(s,{type:'sceneBook',action:'delete',confirm:true,sceneRevision:v.revision}),/책이 그사이 바뀌었습니다/);
  await assert.rejects(as(s,{type:'sceneBook',action:'delete',confirm:true,bookRef:'other-book',sceneRevision:v.revision}),/책이 그사이 바뀌었습니다/);
  assert.equal((await load(s)).nodes.length,2);assert.equal(f.calls.bookDelete.length,0);
  await as(s,{type:'sceneBook',action:'delete',confirm:true,bookRef:v.book.ref,sceneRevision:v.revision});assert.equal(f.calls.bookDelete.length,1);
 });
 function panel(){
  const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
  const root=document.createElement('div');document.body.append(root);const sent=[];let listener,answer;
  const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}}),showConfirm:()=>new Promise(r=>answer=r)},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
  const state={version:1,revision:0,items:[],candidates:[],undo:[]};
  const node={id:'n1',kind:'scene',label:'장면 1–20',title:'원래 항목',body:'[이야기 1일차] 원래 본문',keywords:['민수'],scope:'public',start:1,end:20,count:20,revision:1,tokens:20,state:'approved',reason:'',mode:'constant',parentId:'',children:[],entry:true,entryEdited:false};
  const chronicle={revision:3,nodes:[node],candidates:[],settings:{inject:true,budget:2000,keywords:true,scanDepth:6,autoHide:false,protectRecent:10,maxBody:600,mergeBody:900},book:{name:'기억 보관함 장면록 · abc123',ref:'book-1',attached:true},constantTokens:20,permission:true,lumibooks:false,branch:false,hidden:0,next:{start:'21',end:'40'},total:60};
  const reply=(r,extra={})=>listener({requestId:r.requestId,ok:true,chatId:'a',state,...extra});
  const last=t=>sent.filter(r=>r.type===t).at(-1);
  const click=t=>{const b=[...root.querySelectorAll('button')].find(b=>b.textContent===t);assert.ok(b,t);b.click();};
  reply(sent[0]);root.querySelector('[data-tab=scenes]').click();reply(last('count'),{total:60,hidden:[]});reply(last('sceneLoad'),{chronicle});
  const open=action=>{if(action==='sceneDelete')click('장면 1–20 「원래 항목」');click(action==='sceneDelete'?'삭제':'책 삭제');assert.equal(typeof answer,'function');};
  return {root,sent,reply,last,click,open,chronicle,cleanup,confirm:async ok=>{answer({confirmed:ok});await new Promise(r=>setImmediate(r));}};
 }
 for(const action of ['sceneDelete','sceneBook']){
  for(const [change,edit] of [['revision',c=>{c.revision=4;c.nodes[0].revision=2;c.nodes[0].body='[이야기 2일차] 새 본문';}],...(action==='sceneBook'?[['book',c=>{c.book={...c.book,ref:'book-2'};}]]:[])])
   test(target+' C14 '+action+' confirmation answered after a '+change+' change in the same chat sends nothing',async()=>{
    const v=panel();v.open(action);
    v.click('다시 동기화');const next=structuredClone(v.chronicle);edit(next);v.reply(v.last('sceneSync'),{chronicle:next});
    await v.confirm(true);
    assert.equal(v.last(action),undefined,'no delete request');assert.match(v.root.textContent,/장면록이 바뀌어/);v.cleanup();
   });
  test(target+' C14 '+action+' confirmed with nothing changed is sent for the opened revision'+(action==='sceneBook'?' and book':''),async()=>{
   const v=panel();v.open(action);await v.confirm(true);const r=v.last(action);
   assert.ok(r);assert.equal(r.sceneRevision,3);if(action==='sceneBook'){assert.equal(r.bookRef,'book-1');assert.equal(r.confirm,true);}else assert.equal(r.id,'n1');
   v.cleanup();
  });
 }

 // ---- C6-R1: settings changed while the attempt receipt is written ----
 function autoFixture(){
  const f={db:new Map(),messages:[],calls:[],output:'[{"layer":"wiki","text":"AUTO_CANDIDATE","scope":"public"}]',receiptWrites:0};
  f.add=(n,label)=>{for(let i=0;i<n;i++)for(const user of [true,false]){const k=f.messages.length;f.messages.push({id:'m'+k,is_user:user,content:label+'_'+k,extra:{}});}};f.add(1,'BEFORE');
  f.api={permissions:{has:()=>true},chats:{get:async(id,u)=>id==='a'&&u==='owner'?{id,metadata:{}}:null},chat:{getMessages:async()=>structuredClone(f.messages)},connections:{get:async()=>({model:'mock',provider:'mock'})},
   userStorage:{exists:async(k,u)=>f.db.has(u+'/'+k),getJson:async(k,o)=>structuredClone(f.db.get(o.userId+'/'+k)),
    setJson:async(k,v,o)=>{if(k.endsWith('/attempt.json')){f.receiptWrites++;if(f.receiptWait){const w=f.receiptWait;f.receiptWait=null;w.started.resolve();await w.release.promise;}if(f.failClose&&f.receiptWrites>1)throw Error('receipt close failed');}f.db.set(o.userId+'/'+k,structuredClone(v));}},
   generate:{raw:async r=>{f.calls.push(r);return {content:f.output};}},sendToFrontend:()=>{}};
  f.reset=()=>f.s=createService(f.api,{autoDelayMs:0});f.reset();
  f.run=r=>f.s.run({chatId:'a',...r},'owner');
  f.enable=(extra={})=>f.run({type:'autoSettings',enabled:true,every:3,mode:'raw',connection:'c',...extra});f.disable=()=>f.enable({enabled:false});
  f.auto=()=>f.s.onGenerationEnded({chatId:'a',messageId:'reply',generationType:'normal'},'owner');
  f.settings=()=>f.db.get('owner/chats/a/auto.json');f.receipt=()=>f.db.get('owner/chats/a/attempt.json');
  f.wait=()=>{const w={started:deferred(),release:deferred()};f.receiptWait=w;return w;};return f;
 }
 for(const [name,reenable,failClose] of [['OFF',false,false],['OFF→ON',true,false],['OFF→ON, closing the receipt fails',true,true]])
  test(target+' C6-R1 receipt write pending then '+name+': old span never sent, chat not paused afterwards',async()=>{
   const f=autoFixture();f.failClose=failClose;await f.enable();f.add(3,'OLD');
   const w=f.wait(),p=f.auto();await w.started.promise;await f.disable();if(reenable)await f.enable();w.release.resolve();const out=await p;f.failClose=false;
   assert.equal(f.calls.length,0,'no model call after the settings changed');assert.equal(out.skip,reenable?'stale':'off');
   const id=f.receipt().id;
   if(failClose)assert.equal(f.settings().lastAttempt,id,'closed through auto.json instead');else assert.equal(f.receipt().sent,false,'receipt closed as not sent');
   if(!reenable)await f.enable();
   f.reset();// a worker restart does not turn the closed receipt into a pause either
   assert.notEqual((await f.run({type:'load'})).auto.paused,true);
   f.add(3,'NEW');const next=await f.auto();assert.equal(next.ok,true,JSON.stringify(next));
   assert.equal(f.calls.length,1);assert.doesNotMatch(f.calls[0].messages[1].content,/OLD_|BEFORE_/);assert.match(f.calls[0].messages[1].content,/NEW_/);
  });
 test(target+' C6-R1 nothing changed while the receipt is written: the call goes out once and the receipt is matched',async()=>{
  const f=autoFixture();await f.enable();f.add(3,'OLD');const w=f.wait(),p=f.auto();await w.started.promise;w.release.resolve();
  assert.equal((await p).ok,true);assert.equal(f.calls.length,1);assert.equal(f.settings().lastAttempt,f.receipt().id);assert.equal(f.receipt().sent,undefined);
 });
}
