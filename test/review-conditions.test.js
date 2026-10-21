import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
// 0.3.4 regressions, run against both the source modules and the built dist bundles:
// numeric input (no silent rewrite), automatic analysis generations and lost position
// writes, memory check hold/lock gates, delete confirmation bound to its chat, and
// hidden messages analyzed like any other message.
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setTimeout(r,0));
const targets=[
 ['source',()=>import('../src/service.js'),()=>import('../src/core.js'),()=>import('../src/frontend.js')],
 ['dist',()=>import('../dist/backend.js'),()=>import('../dist/backend.js'),()=>import('../dist/frontend.js')]
];
for(const [target,loadService,loadCore,loadFrontend] of targets){
 const {createService}=await loadService(),core=await loadCore(),{setup}=await loadFrontend();

 // ---- panel fixture ----
 function mount({answer=async()=>({confirmed:true}),state}={}){
  const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
  const root=document.createElement('div');document.body.append(root);const sent=[],asked=[];let listener,switcher;
  const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}}),showConfirm:o=>{asked.push(o);return answer(o);}},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:(_,fn)=>{switcher=fn;return()=>{};}}});
  const base=state||{version:1,revision:0,undo:[],items:[],candidates:[]};
  const respond=(extra={})=>listener({requestId:sent.at(-1).requestId,ok:true,chatId:'a',state:base,...extra});
  respond({});
  const click=t=>{const b=[...root.querySelectorAll('button')].find(x=>x.textContent===t);assert.ok(b,t);b.click();};
  return {root,sent,asked,respond,click,cleanup,switcher:p=>switcher(p),listener:r=>listener(r),state:base};
 }
 function analysisView(total=141,hidden=[]){
  const v=mount();v.click('설정');v.respond({connections:[{id:'chosen',name:'fixture',model:'fixture'}]});
  const s=v.root.querySelector('[aria-label="모델 연결"]');for(const o of s.querySelectorAll('option'))o.toggleAttribute('selected',o.getAttribute('value')==='chosen');s.onchange();
  v.click('분석');v.respond({total,hidden});
  v.type=(label,value)=>{const x=v.root.querySelector(`[aria-label="${label}"]`);x.value=value;x.oninput();return x;};
  v.run=()=>v.root.querySelector('[data-run="analyze"]');
  v.summary=()=>v.root.querySelector('[data-source-summary]').textContent;
  v.analyzes=()=>v.sent.filter(x=>x.type==='analyze');
  return v;
 }

 // ---- C5: numeric input ----
 for(const raw of ['1.5','-1','1e1','15abc','0x10',''])test(target+' C5 recent N "'+raw+'" shows an error and sends no analyze request',()=>{
  const v=analysisView(),n=v.type('최근 메시지 개수',raw);
  assert.equal(n.value,raw,'the typed text is not rewritten');assert.equal(v.run().disabled,true);
  assert.equal(v.root.querySelector('[data-source-summary]').dataset.sourceSummary,'error');
  assert.match(v.root.querySelector('.lv-warning').textContent,/정수/);
  v.run().click();n.onchange();v.run().click();assert.equal(v.analyzes().length,0);assert.equal(n.value,raw);v.cleanup();
 });
 for(const [label,raw] of [['범위 1 시작','1.5'],['범위 1 끝','-1'],['범위 1 시작','2a'],['범위 1 끝','3.0']])test(target+' C5 range '+label+' "'+raw+'" blocks analysis',()=>{
  const v=analysisView();v.click('범위');v.type('범위 1 시작','10');v.type('범위 1 끝','20');assert.equal(v.run().disabled,false);
  v.type(label,raw);assert.equal(v.run().disabled,true);assert.match(v.root.textContent,/1 이상의 정수/);v.run().click();assert.equal(v.analyzes().length,0);
  assert.equal(v.root.querySelector(`[aria-label="${label}"]`).value,raw);
  // '+ 범위 추가' never invents a range from a malformed row either.
  assert.equal(v.root.querySelector('.lv-add').disabled,true);v.cleanup();
 });
 test(target+' C5 valid integers keep sending exactly what was typed',()=>{
  let v=analysisView();v.type('최근 메시지 개수','15');assert.equal(v.summary(),'대화 127–141 (15개)');v.run().click();assert.deepEqual(v.analyzes().at(-1).source,{scope:'last',n:'15'});v.cleanup();
  v=analysisView();v.click('범위');v.type('범위 1 시작','10');v.type('범위 1 끝','20');v.run().click();assert.deepEqual(v.analyzes().at(-1).source,{scope:'range',ranges:[{start:'10',end:'20'}]});v.cleanup();
 });
 test(target+' C5 malformed input is blocked even before the message count arrives',()=>{
  const v=mount();v.click('설정');v.respond({connections:[{id:'chosen',name:'fixture',model:'fixture'}]});const s=v.root.querySelector('[aria-label="모델 연결"]');for(const o of s.querySelectorAll('option'))o.toggleAttribute('selected',o.getAttribute('value')==='chosen');s.onchange();
  v.click('분석');assert.equal(v.sent.at(-1).type,'count');
  const n=v.root.querySelector('[aria-label="최근 메시지 개수"]');n.value='1.5';n.oninput();const run=v.root.querySelector('[data-run="analyze"]');
  assert.equal(run.disabled,true);run.click();assert.equal(v.sent.filter(x=>x.type==='analyze').length,0);v.cleanup();
 });
 test(target+' C5 auto interval is validated, not rewritten',()=>{
  const v=mount();v.click('설정');v.respond({connections:[{id:'chosen',name:'fixture',model:'fixture'}]});const s=v.root.querySelector('[aria-label="모델 연결"]');for(const o of s.querySelectorAll('option'))o.toggleAttribute('selected',o.getAttribute('value')==='chosen');s.onchange();
  const n=v.root.querySelector('[aria-label="자동 분석 간격"]');
  for(const raw of ['1.5','-5','1e1','15abc']){n.value=raw;n.oninput?.();assert.equal(n.value,raw);v.root.querySelector('[data-auto-save]').click();assert.ok(!v.sent.some(x=>x.type==='autoSettings'),raw);}
  n.value='12';v.root.querySelector('[data-auto-save]').click();assert.equal(v.sent.at(-1).type,'autoSettings');assert.equal(v.sent.at(-1).every,12);v.cleanup();
 });
 test(target+' C5 server rejects non-integer scope numbers before any model call',async()=>{
  assert.ok(!core.resolveScope({scope:'last',n:'1.5'},100).ok);assert.ok(!core.resolveScope({scope:'last',n:1.5},100).ok);assert.ok(!core.resolveScope({scope:'last',n:'1e1'},100).ok);
  assert.ok(!core.rangeStatus({start:'0x10',end:'20'},100).ok);assert.ok(core.rangeStatus({start:'10',end:20},100).ok);
  const f=autoFixture();await f.run({type:'load'});
  for(const source of [{scope:'last',n:'1.5'},{scope:'last',n:'-1'},{scope:'last',n:'1e1'},{scope:'range',ranges:[{start:'1.5',end:'2'}]},{scope:'range',ranges:[{start:'1',end:'2abc'}]}])
   await assert.rejects(f.run({type:'analyze',revision:0,mode:'raw',connection:'chosen',source}),/정수/,JSON.stringify(source));
  assert.equal(f.gen().length,0);
  for(const every of ['1e1','4.5',4.5,'0x10'])await assert.rejects(f.enable({every}),/정수/);
  assert.equal(f.auto(),undefined);
 });

 // ---- automatic analysis fixture ----
 function autoFixture(){
  const f={db:new Map(),calls:[],messages:[],next:0,output:'[{"layer":"wiki","text":"AUTO_CANDIDATE","scope":"public"}]',failAutoWrites:false};
  f.add=(n,label='NEW',extra={})=>{for(let j=0;j<n;j++)for(const user of [true,false]){const i=f.next++;f.messages.push({id:'m'+i,is_user:user,content:label+'_'+i,extra:{...extra}});}};f.add(1,'BEFORE');
  f.api={permissions:{has:()=>true},chats:{get:async(id,u)=>id==='a'&&u==='alice'?{id,metadata:{}}:null},chat:{getMessages:async()=>structuredClone(f.messages)},
   connections:{get:async(id)=>{f.calls.push(['connection',id]);if(f.connectionWait){const x=f.connectionWait;f.connectionWait=null;x.started.resolve();await x.release.promise;}return {id,model:'fixture',provider:'fixture'};}},
   userStorage:{exists:async(k,u)=>f.db.has(u+'/'+k),getJson:async(k,o)=>structuredClone(f.db.get(o.userId+'/'+k)),setJson:async(k,v,o)=>{if(f.failAutoWrites&&k.endsWith('/auto.json'))throw Error('injected auto.json write failure');if(f.failAttemptWrites&&k.endsWith('/attempt.json'))throw Error('injected attempt write failure');f.db.set(o.userId+'/'+k,structuredClone(v));}},
   generate:{raw:async input=>{f.calls.push(['generate',input]);if(f.generateWait){const x=f.generateWait;f.generateWait=null;x.started.resolve();await x.release.promise;}return {content:f.output};}},
   sendToFrontend:(p,u)=>f.calls.push(['notify',u,p])};
  f.s=createService(f.api,{autoDelayMs:0});f.run=(r,u='alice')=>f.s.run({chatId:'a',...r},u);
  f.enable=(extra={})=>f.run({type:'autoSettings',enabled:true,every:3,mode:'raw',connection:'chosen',...extra});f.disable=()=>f.enable({enabled:false});
  f.ended=()=>f.s.onGenerationEnded({chatId:'a',messageId:'reply',generationType:'normal'},'alice');
  f.gen=()=>f.calls.filter(x=>x[0]==='generate');f.auto=()=>f.db.get('alice/chats/a/auto.json');f.data=()=>f.db.get('alice/chats/a/data.json');
  f.wait=kind=>{const x={started:deferred(),release:deferred()};f[kind+'Wait']=x;return x;};return f;
 }

 // ---- C6 ----
 test(target+' C6 turning off while the connection lookup is pending submits nothing',async()=>{
  const f=autoFixture();await f.enable();f.add(3);const w=f.wait('connection');const running=f.s.autoCheck('a','alice');await w.started.promise;
  await f.disable();assert.equal(f.auto().enabled,false);w.release.resolve();const out=await running;
  assert.equal(f.gen().length,0,'no model call after OFF was saved');assert.equal(out.skip,'off');assert.equal(f.data(),undefined);
 });
 test(target+' C6 off and on again while the lookup is pending: the old job does not submit',async()=>{
  const f=autoFixture();await f.enable();f.add(3);const w=f.wait('connection');const running=f.s.autoCheck('a','alice');await w.started.promise;
  await f.disable();await f.enable();w.release.resolve();assert.equal((await running).skip,'stale');assert.equal(f.gen().length,0);
 });
 test(target+' C6 a stale completion after re-enabling neither rewinds the marker nor replays pre-enable chat',async()=>{
  const f=autoFixture();await f.enable();f.add(3,'OLD_RUN');const w=f.wait('generate');const running=f.s.autoCheck('a','alice');await w.started.promise;
  await f.disable();f.add(3,'BEFORE_REENABLE');await f.enable();const enabledMarker=f.auto().marker;
  w.release.resolve();assert.equal((await running).skip,'stale');
  assert.deepEqual(f.auto().marker,enabledMarker,'fresh start point kept');assert.equal(f.data(),undefined,'stale candidates not added');
  assert.equal((await f.ended()).skip,'count');assert.equal(f.gen().length,1);
  f.add(3,'AFTER');assert.equal((await f.ended()).ok,true);const input=f.gen()[1][1].messages[1].content;
  assert.match(input,/AFTER/);assert.doesNotMatch(input,/BEFORE_REENABLE|OLD_RUN/);
 });
 test(target+' C6 a stale failure does not write a failure point into the new settings',async()=>{
  const f=autoFixture();await f.enable();f.add(3);f.api.generate.raw=async input=>{f.calls.push(['generate',input]);await f.disable();await f.enable();throw Error('provider down');};
  const out=await f.s.autoCheck('a','alice');assert.match(out.error,/provider down/);assert.equal(f.auto().failed,null);assert.equal(f.auto().last,null);
 });
 test(target+' C6 same-generation completion applies normally; a plain settings save keeps the generation',async()=>{
  const f=autoFixture();await f.enable();f.add(3);const w=f.wait('generate');const running=f.s.autoCheck('a','alice');await w.started.promise;
  const gen=f.auto().gen;await f.enable({every:4});assert.equal(f.auto().gen,gen,'interval change keeps the generation');
  w.release.resolve();const out=await running;assert.equal(out.ok,true);assert.equal(f.data().candidates.length,1);assert.equal(f.auto().marker.id,f.messages.at(-1).id);
  assert.equal(f.data().candidates[0].scope,'unknown');
 });
 test(target+' C6 changing the connection while the lookup is pending skips the old job',async()=>{
  const f=autoFixture();await f.enable();f.add(3);const w=f.wait('connection');const running=f.s.autoCheck('a','alice');await w.started.promise;
  await f.enable({connection:'other'});w.release.resolve();assert.equal((await running).skip,'stale');assert.equal(f.gen().length,0);
  assert.equal((await f.ended()).ok,true);assert.equal(f.gen()[0][1].connection_id,'other');
 });

 // ---- C7 ----
 test(target+' C7 lost position write: not reported as success, no re-send, recovers to the next span only',async()=>{
  const f=autoFixture();await f.enable();f.add(3);f.failAutoWrites=true;
  const first=await f.ended();assert.equal(first.ok,undefined);assert.equal(first.paused,true);assert.equal(first.added,1);assert.match(first.error,/위치를 저장하지 못해/);
  const pushed=f.calls.filter(x=>x[0]==='notify').at(-1)[2];assert.equal(pushed.auto.paused,true);assert.equal(pushed.auto.last.ok,false);
  const loaded=await f.run({type:'load'});assert.equal(loaded.auto.paused,true);assert.match(loaded.auto.last.error,/자동 분석을 멈췄습니다/);
  assert.equal((await f.ended()).skip,'paused');f.add(3);assert.equal((await f.ended()).skip,'paused');
  assert.equal(f.gen().length,1,'same span never sent again');assert.equal(f.data().candidates.length,1);
  // Storage works again: the stored outcome is written first, then only new turns are sent.
  f.failAutoWrites=false;assert.equal((await f.ended()).skip,'resumed');assert.equal(f.gen().length,1);assert.equal((await f.run({type:'load'})).auto.paused,undefined);
  assert.equal((await f.ended()).ok,true);assert.equal(f.gen().length,2);const input=f.gen()[1][1].messages[1].content;
  assert.doesNotMatch(input,/NEW_[2-7]\b/);assert.match(input,/NEW_8\b/);assert.equal(f.data().candidates.length,2);
 });
 test(target+' C7 saving the settings again acknowledges a paused run without re-sending',async()=>{
  const f=autoFixture();await f.enable();f.add(3);f.failAutoWrites=true;await f.ended();const end=f.messages.at(-1).id;
  f.failAutoWrites=false;await f.enable();assert.equal(f.auto().marker.id,end);assert.equal(f.auto().last.ok,true);
  assert.equal((await f.ended()).skip,'count');assert.equal(f.gen().length,1);
 });
 test(target+' C7 after a worker restart the saved candidates still stop a re-send of their span',async()=>{
  const f=autoFixture();await f.enable();f.add(3);f.failAutoWrites=true;await f.ended();f.failAutoWrites=false;
  f.s=createService(f.api,{autoDelayMs:0});
  assert.equal((await f.ended()).skip,'count');assert.equal(f.gen().length,1);
  f.add(3,'LATER');assert.equal((await f.ended()).ok,true);assert.doesNotMatch(f.gen()[1][1].messages[1].content,/NEW_/);
 });
 test(target+' C7 a failure record that cannot be stored pauses instead of retrying every reply',async()=>{
  const f=autoFixture();await f.enable();f.add(3);f.failAutoWrites=true;f.api.generate.raw=async input=>{f.calls.push(['generate',input]);throw Error('provider down');};
  const out=await f.ended();assert.match(out.error,/provider down/);
  for(let i=0;i<3;i++)assert.equal((await f.ended()).skip,'paused');assert.equal(f.gen().length,1);
 });

 // C7 residual: a result that leaves no candidate evidence (empty result, provider
 // error) and whose position write is lost must not be re-sent after a worker restart.
 for(const [name,setup] of [['empty result',f=>{f.output='[]';}],['provider error',f=>{f.api.generate.raw=async input=>{f.calls.push(['generate',input]);throw Error('provider down');};}]]){
  test(target+' C7 restart after '+name+' and a lost position write: paused, nothing re-sent, settings save resumes after the span',async()=>{
   const f=autoFixture();await f.enable();f.add(3);setup(f);f.failAutoWrites=true;
   await f.ended();assert.equal(f.gen().length,1);assert.equal((await f.ended()).skip,'paused');
   f.failAutoWrites=false;f.s=createService(f.api,{autoDelayMs:0});// worker restart: the in-memory pause is gone
   assert.equal((await f.ended()).skip,'uncertain');assert.equal(f.gen().length,1,'same span not sent again');
   const loaded=await f.run({type:'load'});assert.equal(loaded.auto.paused,true);assert.match(loaded.auto.last.error,/기록하지 못한 채 중단/);
   f.add(3,'LATER');assert.equal((await f.ended()).skip,'uncertain');assert.equal(f.gen().length,1);
   // Saving the settings acknowledges it: counting resumes after the attempted span.
   f.output='[{"layer":"wiki","text":"AUTO_CANDIDATE","scope":"public"}]';f.api.generate.raw=async input=>{f.calls.push(['generate',input]);return {content:f.output};};
   await f.enable();assert.equal((await f.run({type:'load'})).auto.paused,undefined);
   assert.equal((await f.ended()).ok,true);assert.equal(f.gen().length,2);const input=f.gen()[1][1].messages[1].content;
   assert.doesNotMatch(input,/NEW_/);assert.match(input,/LATER_/);
  });
 }
 test(target+' C7 chunked run: each chunk has its own receipt; a lost write on chunk 2 after restart pauses without re-sending either chunk',async()=>{
  const f=autoFixture();await f.enable();
  for(const [i,user,label] of [[0,true,'CHUNK1'],[1,false,'CHUNK1'],[2,true,'CHUNK2'],[3,false,'CHUNK2'],[4,true,'CHUNK3']])f.messages.push({id:'big'+i,is_user:user,content:label+'_'+'z'.repeat(25000),extra:{}});
  let n=0;f.api.generate.raw=async input=>{f.calls.push(['generate',input]);if(++n===2){f.failAutoWrites=true;return {content:'[]'};}return {content:f.output};};
  const out=await f.ended();assert.equal(f.gen().length,2);assert.equal(out.paused,true);
  assert.equal(f.auto().marker.id,'big1','chunk 1 position stored');assert.equal(f.data().candidates.length,1);
  f.failAutoWrites=false;f.s=createService(f.api,{autoDelayMs:0});
  assert.equal((await f.ended()).skip,'uncertain');assert.equal(f.gen().length,2,'chunk 2 not re-sent after restart');
  await f.enable();assert.equal(f.auto().marker.id,'big3','settings save resumes after chunk 2');
  f.add(3,'LATER');assert.equal((await f.ended()).ok,true);const input=f.gen()[2][1].messages[1].content;
  assert.match(input,/CHUNK3_/);assert.doesNotMatch(input,/CHUNK[12]_/);
 });
 test(target+' C7 the attempt receipt is stored before the call; if it cannot be, nothing is sent',async()=>{
  const f=autoFixture();await f.enable();f.add(3);f.failAttemptWrites=true;
  const out=await f.ended();assert.equal(out.skip,'attempt');assert.equal(f.gen().length,0);
  f.failAttemptWrites=false;assert.equal((await f.ended()).ok,true);assert.equal(f.gen().length,1);
  assert.equal(f.db.get('alice/chats/a/attempt.json').id,f.auto().lastAttempt,'stored outcome closes the receipt');
  f.s=createService(f.api,{autoDelayMs:0});assert.equal((await f.ended()).skip,'count','a recorded attempt does not pause after restart');
 });
 test(target+' C7 a result dropped as stale closes its receipt, so re-enabling never pauses on it',async()=>{
  const f=autoFixture();await f.enable();f.add(3);const w=f.wait('generate');const running=f.s.autoCheck('a','alice');await w.started.promise;
  await f.disable();await f.enable();w.release.resolve();assert.equal((await running).skip,'stale');
  f.s=createService(f.api,{autoDelayMs:0});f.add(3,'AFTER');assert.equal((await f.ended()).ok,true);assert.match(f.gen()[1][1].messages[1].content,/AFTER_/);
 });

 // ---- hidden messages in automatic analysis ----
 test(target+' hidden messages count as user turns and are sent by automatic analysis',async()=>{
  const f=autoFixture();await f.enable();f.add(2,'SHOWN');f.add(1,'HIDDEN',{hidden:true});
  assert.equal((await f.ended()).ok,true);const input=f.gen()[0][1].messages[1].content;assert.match(input,/HIDDEN_/);assert.match(input,/SHOWN_/);
  assert.equal(f.data().candidates[0].evidence.length,6);
 });

 // ---- C8: memory check ----
 const mem=(id,extra={})=>({id,layer:'wiki',text:'[1일차] TEXT_'+id,scope:'public',status:'active',evidence:[],...extra});
 function healthFixture(items){
  const f=autoFixture();f.messages=[{id:'h1',content:'CHAT_SHOWN',extra:{}},{id:'h2',content:'CHAT_HIDDEN',extra:{hidden:true}}];f.output='[]';
  f.db.set('alice/chats/a/data.json',{...core.empty(),items});f.health=()=>f.run({type:'health',mode:'raw',connection:'chosen'});return f;
 }
 test(target+' C8 branch-held, imported, resume-required and locked memories are never sent to the check',async()=>{
  const held=[mem('branch',{branchHold:true}),mem('imported',{importedScope:true}),mem('resume',{resumeRequired:true}),mem('locked',{locked:true}),mem('hold',{hold:true})];
  let f=healthFixture(held);await assert.rejects(f.health(),/점검할 기억이 없습니다/);assert.equal(f.gen().length,0);
  f=healthFixture([...held,mem('open')]);await f.health();const input=f.gen()[0][1].messages[1].content;
  assert.match(input,/TEXT_open/);for(const id of ['branch','imported','resume','locked','hold'])assert.ok(!input.includes('TEXT_'+id),id);
  // Hidden chat messages are evidence like any other (0.3.4).
  assert.match(input,/CHAT_HIDDEN/);assert.match(input,/CHAT_SHOWN/);
 });
 test(target+' C8 a wiki locked after the check is not overwritten by the stored proposal',async()=>{
  const f=healthFixture([mem('w')]);f.output='[{"action":"update","target":"M1","text":"MODEL_OVERWRITE"}]';const h=await f.health();
  await f.run({type:'put',revision:0,item:{...f.data().items[0],locked:true}});
  const out=await f.run({type:'healthApply',revision:1,ids:[h.health.proposals[0].id]});
  assert.equal(out.state.items[0].text,'[1일차] TEXT_w');assert.equal(out.state.items[0].locked,true);assert.match(out.notice,/제안 0개 반영 · 충돌 1개/);
  assert.throws(()=>core.apply(f.data(),{type:'healthChanges',changes:[{targetId:'w',action:'update',text:'X'}]}),/위키 잠금/);
  for(const flag of ['branchHold','importedScope','resumeRequired'])assert.throws(()=>core.apply({...core.empty(),items:[mem('x',{[flag]:true})]},{type:'healthChanges',changes:[{targetId:'x',action:'archive'}]}),/보류·제한/);
 });
 test(target+' C8 held after the check: conflict; unchanged proposals still apply and undo',async()=>{
  const f=healthFixture([mem('w1'),mem('w2')]);f.output='[{"action":"update","target":"M1","text":"[1일차] NEW_1"},{"action":"archive","target":"M2"}]';const h=await f.health();
  const out=await f.run({type:'healthApply',revision:0,ids:h.health.proposals.map(p=>p.id)});assert.equal(out.state.items[0].text,'[1일차] NEW_1');assert.equal(out.state.items[1].hold,true);
  const undo=await f.run({type:'undo',revision:1});assert.equal(undo.state.items[0].text,'[1일차] TEXT_w1');
  const g=healthFixture([mem('w')]);g.output='[{"action":"update","target":"M1","text":"MODEL"}]';const gh=await g.health();
  const s=g.data();s.items[0].branchHold=true;g.db.set('alice/chats/a/data.json',s);
  const r=await g.run({type:'healthApply',revision:0,ids:[gh.health.proposals[0].id]});assert.equal(r.state.items[0].text,'[1일차] TEXT_w');assert.match(r.notice,/충돌 1개/);
 });
 test(target+' C8 the panel shows a proposal on a locked wiki as a conflict',()=>{
  const state={version:1,revision:1,undo:[],items:[mem('w',{locked:true})],candidates:[]};
  const v=mount({state});v.listener({requestId:v.sent.at(-1)?.requestId,ok:true,chatId:'a',state});
  v.click('새로고침');v.respond({health:{at:1,text:'t',note:'',proposals:[{id:'p1',action:'update',targetId:'w',layer:'wiki',text:'X',reason:'',base:{text:'[1일차] TEXT_w',status:'active',hold:false,scope:'public'}}]}});
  const box=v.root.querySelector('[data-proposal="p1"]');assert.ok(box.classList.contains('is-conflict'));assert.equal(box.querySelector('input').disabled,true);v.cleanup();
 });

 // ---- C9: delete confirmation bound to its chat ----
 const item=(i,extra={})=>({id:i===0?'shared-id':'p'+i,layer:'promises',title:'P'+String(i).padStart(2,'0'),text:'[1일차] TEXT_'+i,scope:'public',status:'active',evidence:[],...extra});
 const chatA=()=>({version:1,revision:0,undo:[],items:Array.from({length:30},(_,i)=>item(i)),candidates:[item(99,{id:'candidate',title:'Candidate',scope:'unknown'})]});
 test(target+' C9 a delete confirmed after switching to another chat sends nothing',async()=>{
  let release;const wait=new Promise(r=>release=r);const v=mount({answer:()=>wait,state:chatA()});
  v.click('약속');v.root.querySelector('[data-select-all="list"]').click();v.click('선택 삭제');
  const stateB={version:1,revision:0,undo:[],items:[item(0)],candidates:[]};v.switcher({chatId:'b'});v.listener({requestId:v.sent.at(-1).requestId,ok:true,chatId:'b',state:stateB});
  release({confirmed:true});await tick();assert.equal(v.sent.filter(x=>x.type==='delete').length,0);assert.match(v.root.textContent,/삭제하지 않았습니다/);v.cleanup();
 });
 test(target+' C9 a delete confirmed after the same chat changed revision sends nothing',async()=>{
  let release;const wait=new Promise(r=>release=r);const v=mount({answer:()=>wait,state:chatA()});
  v.click('약속');v.root.querySelector('[data-select-all="list"]').click();v.click('선택 삭제');
  v.click('새로고침');v.respond({state:{...chatA(),revision:1}});release({confirmed:true});await tick();assert.equal(v.sent.filter(x=>x.type==='delete').length,0);v.cleanup();
 });
 test(target+' C9 a normal confirmation sends the selection with its own chat and revision; cancel sends nothing',async()=>{
  let v=mount({state:chatA()});v.click('약속');v.root.querySelector('[data-select-all="list"]').click();v.click('선택 삭제');await tick();
  const req=v.sent.at(-1);assert.equal(req.type,'delete');assert.equal(req.chatId,'a');assert.equal(req.revision,0);assert.equal(req.ids.length,31);v.cleanup();
  v=mount({answer:async()=>({confirmed:false}),state:chatA()});v.click('약속');v.root.querySelector('[data-select-all="list"]').click();v.click('선택 삭제');await tick();assert.ok(!v.sent.some(x=>x.type==='delete'));v.cleanup();
 });
 test(target+' C9 the service refuses a delete naming IDs that are not in the chat',async()=>{
  const f=autoFixture();f.db.set('alice/chats/a/data.json',{version:1,revision:0,undo:[],items:[item(0)],candidates:[]});
  await assert.rejects(f.run({type:'delete',revision:0,ids:['shared-id','p1','p2']}),/삭제 대상 불일치/);assert.equal(f.data().items.length,1);
  await assert.rejects(f.run({type:'delete',revision:0,ids:[]}),/삭제 대상/);
  const ok=await f.run({type:'delete',revision:0,ids:['shared-id']});assert.equal(ok.state.items.length,0);
  assert.equal((await f.run({type:'undo',revision:1})).state.items.length,1);
 });

 // ---- hidden messages in manual analysis, and the Loom opt-in kept ----
 test(target+' hidden messages are analyzed in recent N and ranges and shown as included',async()=>{
  const v=analysisView(10,[4,5]);v.type('최근 메시지 개수','7');assert.equal(v.summary(),'대화 4–10 (7개, 숨김 2개 포함)');assert.doesNotMatch(v.root.textContent,/숨김 \d+개 제외|분석에서 빠집니다/);v.cleanup();
  const f=autoFixture();f.messages=[{id:'x1',content:'ONE',extra:{}},{id:'x2',content:'TWO_HIDDEN',extra:{hidden:true}}];
  const r=await f.run({type:'analyze',revision:0,mode:'raw',connection:'chosen',source:{scope:'range',ranges:[{start:'2',end:'2'}]}});
  assert.match(f.gen()[0][1].messages[1].content,/TWO_HIDDEN/);assert.match(r.notice,/대화 2 \(1개, 숨김 1개 포함\)/);
 });
 test(target+' Loom summary is sent only when the setting is stored true',async()=>{
  const f=autoFixture();f.api.chats.get=async(id,u)=>id==='a'&&u==='alice'?{id,metadata:{loom_summary:'LOOM_TEXT'}}:null;
  await f.run({type:'analyze',revision:0,mode:'raw',connection:'chosen',source:{scope:'last',n:2}});assert.doesNotMatch(f.gen()[0][1].messages[1].content,/LOOM_TEXT/);
  await f.run({type:'loomSettings',revision:1,enabled:true});await f.run({type:'analyze',revision:1,mode:'raw',connection:'chosen',source:{scope:'last',n:2}});assert.match(f.gen()[1][1].messages[1].content,/LOOM_TEXT/);
 });
}
