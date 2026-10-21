import {test} from 'node:test';import assert from 'node:assert/strict';
import {createService,ANALYSIS_PROMPT,HEALTH_PROMPT,LOOM_ANALYSIS_RULES,LOOM_HEALTH_RULES} from '../src/service.js';
import {SCENE_PROMPT,SCENE_MERGE_PROMPT,scenePrompt,SCENE_DEFAULTS,SCENE_BOOK_PREFIX,sceneEmpty,sceneLabel,sceneBody,sceneBodyIssue,sceneParse,sceneTokens,sceneEvaluate,scenePlan,sceneEntry,sceneValidateMerge,sceneHidePlan,sceneNextRange} from '../src/chronicle.js';
import {fingerprint} from '../src/core.js';
import {sceneFake,makeMessages,rec,approveLast,as,SCENE_REPLY} from './scene-fake.js';
const svc=f=>createService(f.api,{autoDelayMs:1});
const load=async s=>(await as(s,{type:'sceneLoad'})).chronicle;
const entriesOf=f=>[...f.entries.values()];
const byLabel=(f,label)=>entriesOf(f).find(e=>e.comment===label);
async function recordApprove(s,f,ranges,scope='public'){for(const [a,b] of ranges){await rec(s,a,b);await approveLast(s,scope);}}
// ---- Pure rules ----------------------------------------------------------------
test('labels, body cleanup and approval checks: Korean body only, date first, no header',()=>{
 assert.equal(sceneLabel({kind:'scene',range:{start:41,end:60}}),'장면 41–60');
 assert.equal(sceneLabel({kind:'chapter',range:{start:1,end:40}}),'장 1–40');
 assert.equal(sceneBody('## 장면 41–60\n요약: \n[이야기 3일차 밤] 민수가 떠났다.'),'[이야기 3일차 밤] 민수가 떠났다.');
 assert.equal(sceneBody('Chapter 1\n민수가 떠났다.','기록 2026-10-21 19:10'),'[기록 2026-10-21 19:10] 민수가 떠났다.');
 assert.equal(sceneBody('민수가 떠났다.'),'[시각 미상] 민수가 떠났다.');
 assert.equal(sceneBodyIssue('[이야기 1일차] 민수가 왔다.'),'');
 assert.match(sceneBodyIssue('민수가 왔다.'),/날짜 대괄호/);
 assert.match(sceneBodyIssue('장면 41–60\n[이야기 1일차] 민수가 왔다.'),/제목·머리말/);
 assert.match(sceneBodyIssue('[이야기 1일차] 요약: 민수가 왔다.'),/제목·머리말/);
 assert.match(sceneBodyIssue('[이야기 1일차] 장면 41–60 민수가 왔다.'),/제목·머리말/);
 assert.equal(sceneBodyIssue('[이야기 2일차] 장 3개의 편지를 받았다.'),'','prose that starts with 장 is not a header');
 assert.equal(sceneBody('장 3개의 편지를 받았다.','기록 x'),'[기록 x] 장 3개의 편지를 받았다.');
 assert.equal(sceneBody('장면 3\n[이야기 1일차] 민수'),'[이야기 1일차] 민수');
 assert.match(sceneBodyIssue('[이야기 1일차] 민수가 '+SCENE_BOOK_PREFIX+'abc를 봤다.'),/책 이름/);
 assert.match(sceneBodyIssue(''),/비어/);
});
test('scene response: one object, reasoning skipped, promises and flows ride along',()=>{
 const p=sceneParse('<think>생각</think>\n설명 {"title":"창고","body":"장면 1–20\\n[이야기 2일차] 민수가 왔다.","keywords":["민수","[창고]","민수"],"promises":["[이야기 2일차] 내일 만나기로 했다."],"flows":[{"text":"[이야기 2일차] 탈출 준비 중"}]}');
 assert.deepEqual(p,{title:'창고',body:'[이야기 2일차] 민수가 왔다.',keywords:['민수','창고'],promises:['[이야기 2일차] 내일 만나기로 했다.'],flows:['[이야기 2일차] 탈출 준비 중']});
 assert.throws(()=>sceneParse('{"title":"x","body":""}'),/본문/);
 assert.throws(()=>sceneParse('[1,2]'),/JSON 객체/);
 assert.equal(sceneTokens('가나다'),3);assert.equal(sceneTokens('abcdefgh'),2);assert.equal(sceneTokens('가 a'),2);
});
const digestMsgs=async n=>Promise.all(makeMessages(n).map(async m=>({id:m.id,digest:await fingerprint(m.content),hidden:false})));
async function stateWith(ranges,{msgs,kinds={},scope='public',body=()=>'[이야기 1일차] 가나다라마바사',keywords=['민수']}={}){
 msgs=msgs||await digestMsgs(80);const s=sceneEmpty();
 ranges.forEach(([a,b],i)=>{const ids=msgs.slice(a-1,b);s.nodes.push({id:'n'+(i+1),kind:kinds[i]||'scene',title:'',body:body(i),keywords,scope,status:'approved',revision:1,range:{ids:ids.map(m=>m.id),fps:ids.map(m=>m.digest),start:a,end:b},parentId:'',generation:null,entry:null,entryEdited:false,at:0});});
 return {s,msgs};
}
test('activation: newest chapter 1 + newest scenes 3 constant, older scenes keyword, budget trims oldest constant first',async()=>{
 const {s,msgs}=await stateWith([[1,10],[11,20],[21,30],[31,40],[41,50],[51,60]]);
 let p=scenePlan(s,sceneEvaluate(s,msgs));
 assert.deepEqual(s.nodes.map(x=>p.plan.get(x.id)),['keyword','keyword','keyword','constant','constant','constant']);
 // Budget: each body is 12 Hangul + 5 other characters = 14 tokens; room for two only.
 assert.equal(sceneTokens(s.nodes[0].body),14);s.settings.budget=28;p=scenePlan(s,sceneEvaluate(s,msgs));
 assert.deepEqual(s.nodes.map(x=>p.plan.get(x.id)),['keyword','keyword','keyword','keyword','constant','constant']);assert.equal(p.constantTokens,28);
 s.settings.keywords=false;p=scenePlan(s,sceneEvaluate(s,msgs));
 assert.deepEqual(s.nodes.map(x=>p.plan.get(x.id)),['off','off','off','off','constant','constant']);
 s.nodes[0].scope='secret';s.nodes[1].scope='unknown';p=scenePlan(s,sceneEvaluate(s,msgs));
 assert.equal(p.plan.get('n1'),'none');assert.equal(p.plan.get('n2'),'none');
});
test('entry shape: comment is the range label, content is the body only, keyword scan of the last 6 messages',async()=>{
 const {s}=await stateWith([[41,60]]),x=s.nodes[0];
 const k=sceneEntry(x,'keyword',SCENE_DEFAULTS,'chat-1'),c=sceneEntry(x,'constant',SCENE_DEFAULTS,'chat-1'),o=sceneEntry(x,'off',SCENE_DEFAULTS,'chat-1');
 assert.equal(k.comment,'장면 41–60');assert.equal(k.content,x.body);assert.deepEqual(k.key,['민수']);
 assert.equal(k.match_whole_words,false);assert.equal(k.scan_depth,6);assert.equal(k.position,0);assert.equal(k.order_value,41);
 assert.deepEqual([k.constant,k.disabled,c.constant,c.disabled,o.disabled],[false,false,true,false,true]);
 assert.equal(k.exclude_recursion,true);assert.deepEqual(k.extensions,{memory_cabinet:{nodeId:'n1',revision:1,chatId:'chat-1'}});
});
test('merge rules: two or more adjacent, valid, same-scope records; gaps and archived picks refused',async()=>{
 const {s,msgs}=await stateWith([[1,20],[21,40],[45,60]]);const ev=sceneEvaluate(s,msgs);
 assert.equal(sceneValidateMerge(s,ev,['n1']).ok,false);
 assert.equal(sceneValidateMerge(s,ev,['n1','n2']).ok,true);
 assert.match(sceneValidateMerge(s,ev,['n2','n3']).error,/기록되지 않은 메시지/);
 s.nodes[1].scope='unknown';assert.match(sceneValidateMerge(s,sceneEvaluate(s,msgs),['n1','n2']).error,/공개 범위가 다른/);
});
test('next record range continues after the last recorded message with the same length',async()=>{
 const {s}=await stateWith([[1,20],[21,40]]);
 assert.deepEqual(sceneNextRange(s,100),{start:'41',end:'60'});assert.deepEqual(sceneNextRange(s,50),{start:'41',end:'50'});assert.equal(sceneNextRange(s,40),null);
 assert.deepEqual(sceneNextRange(sceneEmpty(),100),{start:'1',end:'20'});
});
// ---- Service: record, approve, book ----------------------------------------------
test('one tap records one range with one Korean model call; promises go to the review queue; panel gets no message text',async()=>{
 const f=sceneFake(),s=svc(f);
 const out=await rec(s,41,60);
 assert.equal(f.calls.generate.length,1);const call=f.calls.generate[0];
 assert.equal(call.messages[0].content,SCENE_PROMPT.replace('{max}','600'));assert.equal(call.model,'fixture-model');
 assert.ok(call.messages[1].content.startsWith('〈원문〉\n[메시지 전송 시각 기준: Asia/Seoul]'));assert.ok(call.messages[1].content.includes('원문 메시지 41 내용'));assert.ok(!call.messages[1].content.includes('원문 메시지 40 내용'));
 assert.equal(out.chronicle.candidates.length,1);assert.equal(out.chronicle.candidates[0].label,'장면 41–60');
 const promise=out.state.candidates.find(x=>x.layer==='promises');assert.equal(promise.scope,'unknown');assert.match(promise.source,/장면 기록 모델 후보 · 대화 41–60/);assert.equal(promise.evidence.length,20);
 const panel=JSON.stringify(out.chronicle);assert.ok(!panel.includes('원문 메시지'));assert.ok(!/"m4[1-9]"/.test(panel),'no message IDs');assert.ok(!panel.includes('sha256:'));
 assert.equal(f.calls.bookCreate.length,0,'nothing is written to a book before approval');
 // A range before every approved record gets no reference block.
 await approveLast(s);await rec(s,1,20);
 assert.ok(!f.calls.generate[1].messages[1].content.includes('〈이전 기록〉'));
});
test('previous approved record is sent as reference; overlapping a recorded range is refused before any call',async()=>{
 const f=sceneFake(),s=svc(f);
 await rec(s,1,20);await approveLast(s);
 await rec(s,21,40);assert.ok(f.calls.generate[1].messages[1].content.startsWith('〈이전 기록〉\n'+SCENE_REPLY.body+'\n〈/이전 기록〉\n\n〈원문〉'));
 await approveLast(s);
 await assert.rejects(()=>rec(s,15,25),/장면 1–20과 범위가 겹칩니다/);assert.equal(f.calls.generate.length,2);
 await assert.rejects(()=>as(s,{type:'sceneRecord',mode:'raw',connection:'conn',source:{scope:'range',ranges:[{start:'1',end:'5'},{start:'6',end:'9'}]}}),/범위 하나씩/);
});
test('approval writes one chat-only book named without the chat; metadata is read-spread-written',async()=>{
 const f=sceneFake(),s=svc(f);
 await rec(s,41,60);const out=await approveLast(s);
 assert.equal(f.calls.bookCreate.length,1);const book=f.calls.bookCreate[0];
 assert.match(book.name,/^기억 보관함 장면록 · [0-9a-f]{6}$/);assert.ok(!book.name.includes(f.names.a));assert.deepEqual(book.metadata,{memory_cabinet_chat_id:'a'});
 const e=byLabel(f,'장면 41–60');assert.equal(e.content,SCENE_REPLY.body);assert.equal(e.constant,true);assert.equal(e.world_book_id,book.id);
 assert.deepEqual(f.meta.a,{loom_summary:'루미버스 요약 원문',wi_state:{keep:{active:true}},chat_variables:{mood:'calm'},chat_world_book_ids:[book.id]});
 assert.equal(f.calls.chatUpdates.length,1);assert.equal(out.chronicle.book.attached,true);
 // A re-sync with nothing new writes nothing.
 const before={u:f.calls.entryUpdate.length,c:f.calls.entryCreate.length,m:f.calls.chatUpdates.length};
 await as(s,{type:'sceneSync'});assert.deepEqual({u:f.calls.entryUpdate.length,c:f.calls.entryCreate.length,m:f.calls.chatUpdates.length},before);
});
test('idempotent book: concurrent approvals, lost pointer, lost create reply and foreign pointer never duplicate',async()=>{
 const f=sceneFake({otherBooks:450}),s=svc(f);
 await rec(s,1,20);await rec(s,21,40);
 const v=await load(s);
 await Promise.allSettled(v.candidates.map(c=>as(s,{type:'sceneApprove',id:c.id,scope:'public',confirmPublic:true,sceneRevision:v.revision})));
 await approveLast(s).catch(()=>{});
 assert.equal(f.calls.bookCreate.length,1,'one book for two approvals');
 // Pointer lost (older storage): the scan over every page finds the same book.
 const stored=f.db.get('chats/a/chronicle.json');stored.book=null;f.db.set('chats/a/chronicle.json',stored);
 await as(s,{type:'sceneSync'});assert.equal(f.calls.bookCreate.length,1);assert.equal(f.db.get('chats/a/chronicle.json').book.id,f.calls.bookCreate[0].id);
 // Pointer to another chat's book is never reused.
 f.books.set('foreign',{id:'foreign',name:'x',metadata:{memory_cabinet_chat_id:'zzz'},created_at:0});
 const s2=f.db.get('chats/a/chronicle.json');s2.book={id:'foreign',name:'x'};f.db.set('chats/a/chronicle.json',s2);
 await as(s,{type:'sceneSync'});assert.equal(f.calls.bookCreate.length,1);assert.equal(f.db.get('chats/a/chronicle.json').book.id,f.calls.bookCreate[0].id);
 assert.equal(entriesOf(f).filter(e=>e.world_book_id==='foreign').length,0);
});
test('a create whose reply is lost is found by the follow-up scan, not created twice',async()=>{
 const f=sceneFake(),s=svc(f);let fail=true;
 f.hooks.afterBookCreate=async()=>{if(fail){fail=false;throw Error('connection reset');}};
 await rec(s,1,20);await approveLast(s);
 assert.equal(f.calls.bookCreate.length,1);assert.equal(f.books.size,1);assert.equal(entriesOf(f).length,1);
 await as(s,{type:'sceneSync'});assert.equal(f.books.size,1);
});
test('no-leak capture: the text a host-shaped assembly sends contains bodies only (no title, label, book or chat name)',async()=>{
 const f=sceneFake(),s=svc(f);
 await recordApprove(s,f,[[1,20],[21,40],[41,60]]);
 const v=await load(s);
 await as(s,{type:'sceneMerge',ids:v.nodes.slice(0,2).map(x=>x.id),mode:'raw',connection:'conn',sceneRevision:v.revision});await approveLast(s);
 // Lumiverse 1.2.5 puts only entry.content into the prompt; comment is the breakdown
 // label (world-info-activation.service.ts:966-973, prompt-assembly.service.ts:3594-3596).
 const active=entriesOf(f).filter(e=>!e.disabled&&(e.constant||e.key.some(k=>'지아가 창고에 갔다'.includes(k))));
 const sent=[];const provider=async body=>{sent.push(JSON.stringify(body));return {content:'ok'};};
 await provider({model:'fake',messages:[...active.sort((a,b)=>a.order_value-b.order_value).map(e=>({role:'system',content:e.content})),{role:'user',content:'지아가 창고에 갔다'}]});
 const wire=sent.join('\n');
 for(const bad of ['장면 1–20','장면 41–60','장 1–40',SCENE_BOOK_PREFIX.trim(),f.names.a,'창고 거래','Chapter','Summary','요약:','memory_cabinet'])assert.ok(!wire.includes(bad),bad);
 assert.equal(active.length,2);assert.ok(active.every(e=>/^\[이야기/.test(e.content)));
 // Our own interceptor never adds the chronicle a second time.
 f.grants.add('interceptor');const turn={role:'user',content:'t',__isChatHistory:true,sourceMessageId:'m60'};
 const inj=await s.intercept([turn],{chatId:'a',userId:'owner'});assert.deepEqual(inj.messages,[turn]);
});
test('merge twice and undo twice: one call per merge, none per undo, children disabled not deleted, coverage never doubles',async()=>{
 const f=sceneFake(),s=svc(f);
 await recordApprove(s,f,[[1,20],[21,40],[41,60]]);
 let v=await load(s);const [n1,n2,n3]=v.nodes;
 await as(s,{type:'sceneMerge',ids:[n1.id,n2.id],mode:'raw',connection:'conn',sceneRevision:v.revision});
 assert.equal(f.calls.generate.length,4);assert.ok(f.calls.generate[3].messages[1].content.startsWith('〈기록 1〉\n'));assert.match(f.calls.generate[3].messages[0].content,/하나의 기록으로 합친다/);
 assert.equal(byLabel(f,'장면 1–20').disabled,false,'candidate only: children still injected');
 v=(await approveLast(s)).chronicle;
 assert.deepEqual(['장면 1–20','장면 21–40'].map(l=>byLabel(f,l).disabled),[true,true]);assert.equal(byLabel(f,'장 1–40').constant,true);
 const ch=v.nodes.find(x=>x.kind==='chapter');
 await as(s,{type:'sceneMerge',ids:[ch.id,n3.id],mode:'raw',connection:'conn',sceneRevision:v.revision});v=(await approveLast(s)).chronicle;
 assert.equal(f.calls.generate.length,5);
 const injected=()=>entriesOf(f).filter(e=>!e.disabled).map(e=>e.comment).sort();
 assert.deepEqual(injected(),['장 1–60']);
 const top=v.nodes.find(x=>x.label==='장 1–60');
 v=(await as(s,{type:'sceneUnmerge',id:top.id,sceneRevision:v.revision})).chronicle;
 assert.deepEqual(injected(),['장 1–40','장면 41–60']);
 v=(await as(s,{type:'sceneUnmerge',id:ch.id,sceneRevision:v.revision})).chronicle;
 assert.deepEqual(injected(),['장면 1–20','장면 21–40','장면 41–60']);
 assert.equal(f.calls.generate.length,5,'undo never calls the model');
 assert.equal(entriesOf(f).filter(e=>e.comment.startsWith('장 ')).length,0,'undone chapters leave the book');
 // Undo of an inner chapter while its parent is live undoes the parent as well.
 v=await load(s);await as(s,{type:'sceneMerge',ids:v.nodes.filter(x=>x.state==='approved').slice(0,2).map(x=>x.id),mode:'raw',connection:'conn',sceneRevision:v.revision});v=(await approveLast(s)).chronicle;
 const inner=v.nodes.find(x=>x.kind==='chapter'&&x.state==='approved');const n3b=v.nodes.find(x=>x.label==='장면 41–60');
 await as(s,{type:'sceneMerge',ids:[inner.id,n3b.id],mode:'raw',connection:'conn',sceneRevision:v.revision});v=(await approveLast(s)).chronicle;
 v=(await as(s,{type:'sceneUnmerge',id:inner.id,sceneRevision:v.revision})).chronicle;
 assert.deepEqual(injected(),['장면 1–20','장면 21–40','장면 41–60']);
});
test('merge refuses gaps and mixed scopes before calling the model',async()=>{
 const f=sceneFake(),s=svc(f);
 await recordApprove(s,f,[[1,20],[25,40]]);await rec(s,41,60);await approveLast(s,'unknown');
 const v=await load(s);const calls=f.calls.generate.length;
 await assert.rejects(()=>as(s,{type:'sceneMerge',ids:[v.nodes[0].id,v.nodes[1].id],mode:'raw',connection:'conn',sceneRevision:v.revision}),/기록되지 않은 메시지/);
 await assert.rejects(()=>as(s,{type:'sceneMerge',ids:[v.nodes[1].id,v.nodes[2].id],mode:'raw',connection:'conn',sceneRevision:v.revision}),/공개 범위가 다른/);
 assert.equal(f.calls.generate.length,calls);
});
test('an edited source message makes the scene stale: its entry is turned off and its chapter goes stale too',async()=>{
 const f=sceneFake(),s=svc(f);
 await recordApprove(s,f,[[1,20],[21,40]]);let v=await load(s);
 await as(s,{type:'sceneMerge',ids:v.nodes.map(x=>x.id),mode:'raw',connection:'conn',sceneRevision:v.revision});await approveLast(s);
 f.msgs.a[4].content='편집된 내용';
 v=(await as(s,{type:'sceneSync'})).chronicle;
 assert.equal(v.nodes.find(x=>x.label==='장면 1–20').state,'archived');assert.equal(v.nodes.find(x=>x.label==='장 1–40').state,'stale');
 assert.equal(byLabel(f,'장 1–40').disabled,true);
 // The event path does the same a moment later (debounced).
 f.msgs.a[4].content='원문 메시지 5 내용';const r=await s.onSceneEvent({chatId:'a'},'owner');assert.equal(r.chronicle.nodes.find(x=>x.label==='장 1–40').state,'approved');assert.equal(byLabel(f,'장 1–40').disabled,false);
});
test('re-recording the same range of a stale scene replaces it after approval',async()=>{
 const f=sceneFake(),s=svc(f);
 await recordApprove(s,f,[[1,20]]);f.msgs.a[2].content='바뀐 원문';
 let v=(await as(s,{type:'sceneSync'})).chronicle;assert.equal(v.nodes[0].state,'stale');assert.equal(byLabel(f,'장면 1–20').disabled,true);
 f.setReply(()=>JSON.stringify({...SCENE_REPLY,body:'[이야기 4일차] 다시 쓴 장면.'}));
 await rec(s,1,20);v=await load(s);assert.equal(v.candidates[0].replaces,v.nodes[0].id);
 v=(await approveLast(s)).chronicle;assert.equal(v.nodes.length,1);assert.equal(v.nodes[0].revision,2);assert.equal(v.nodes[0].state,'approved');
 assert.equal(byLabel(f,'장면 1–20').content,'[이야기 4일차] 다시 쓴 장면.');assert.equal(byLabel(f,'장면 1–20').disabled,false);
});
test('secret and private scenes never reach the book; turning a public scene secret deletes its entry',async()=>{
 const f=sceneFake(),s=svc(f);
 await rec(s,1,20);let v=await load(s);
 await as(s,{type:'sceneEdit',id:v.candidates[0].id,scope:'secret',body:'[이야기 1일차] 비밀 내용 NEVER_BOOK',sceneRevision:v.revision});
 v=await load(s);await assert.rejects(()=>as(s,{type:'sceneApprove',id:v.candidates[0].id,scope:'public',confirmPublic:true,sceneRevision:v.revision}),/로어북에 쓰지 않습니다/);
 await as(s,{type:'sceneApprove',id:v.candidates[0].id,scope:'unknown',sceneRevision:v.revision});
 await rec(s,21,40);await approveLast(s,'unknown');
 assert.equal(entriesOf(f).length,0);assert.equal(f.calls.bookCreate.length,0);
 v=await load(s);assert.equal(v.nodes[0].scope,'secret');assert.equal(v.nodes[1].scope,'unknown');
 await rec(s,41,60);await approveLast(s);assert.equal(entriesOf(f).length,1);
 v=await load(s);const pub=v.nodes.find(x=>x.scope==='public');
 await assert.rejects(()=>as(s,{type:'sceneEdit',id:v.nodes[1].id,scope:'public',sceneRevision:v.revision}),/명시 확인/);
 await as(s,{type:'sceneEdit',id:pub.id,scope:'secret',sceneRevision:v.revision});
 assert.equal(entriesOf(f).length,0);
 for(const e of f.calls.entryCreate)assert.ok(!e.input.content.includes('NEVER_BOOK'));
});
test('approval rejects a body with a header or without a date; edits are re-checked',async()=>{
 const f=sceneFake(),s=svc(f);f.setReply(()=>JSON.stringify({...SCENE_REPLY,body:'민수가 떠났다.'}));
 await rec(s,1,20);let v=await load(s);assert.match(v.candidates[0].body,/^\[기록 2025-10-09 \d\d:\d\d\] 민수가 떠났다\.$/,'send time of the last message as fallback date');
 await assert.rejects(()=>as(s,{type:'sceneEdit',id:v.candidates[0].id,body:'장면 1–20\n[이야기 1일차] 민수',sceneRevision:v.revision}),/제목·머리말/);
});
// ---- Auto-hide ---------------------------------------------------------------------
test('auto-hide: off by default; on hides constant-covered turns except the last 10; only ours are ever unhidden',async()=>{
 const f=sceneFake({messages:makeMessages(40)}),s=svc(f);
 f.msgs.a[2].extra={hidden:true};// hidden by the user beforehand
 await recordApprove(s,f,[[1,10],[11,20],[21,35]]);
 assert.equal(f.calls.hidden.length,0,'default off: no hide API call');
 let v=await load(s);
 v=(await as(s,{type:'sceneSettings',autoHide:true,sceneRevision:v.revision})).chronicle;
 const hidden=()=>f.msgs.a.filter(m=>m.extra?.hidden).map(m=>m.id);
 assert.deepEqual(hidden(),Array.from({length:30},(_,i)=>'m'+(i+1)),'1–30 hidden (31–35 are inside the last 10)');
 assert.ok(!f.calls.hidden.flatMap(c=>c.ids).includes('m3'),'user-hidden message is not taken over');
 // The user unhides one of ours: it stays visible from then on.
 f.msgs.a[5].extra={hidden:false};
 v=(await as(s,{type:'sceneSync'})).chronicle;assert.equal(f.msgs.a[5].extra.hidden,false);
 // Budget demotes the oldest scene to keyword: its turns come back.
 v=(await as(s,{type:'sceneSettings',budget:200,sceneRevision:v.revision})).chronicle;
 await recordApprove(s,f,[[36,40]]);
 v=await load(s);assert.equal(v.nodes.find(x=>x.label==='장면 1–10').mode,'keyword');
 assert.deepEqual(hidden().filter(id=>['m1','m2','m4','m5','m7','m8','m9','m10'].includes(id)),[],'demoted scene unhidden');
 assert.ok(hidden().includes('m3'),'user-hidden one stays hidden');
 // Off: every message we hid is shown again; the user's own stays hidden.
 v=(await as(s,{type:'sceneSettings',autoHide:false,sceneRevision:v.revision})).chronicle;
 assert.deepEqual(hidden(),['m3']);assert.equal(v.hidden,0);
});
test('auto-hide plan never hides inside the protected tail, even with a protect window larger than the chat',async()=>{
 const {s,msgs}=await stateWith([[1,10]]);s.settings.autoHide=true;s.settings.protectRecent=80;s.nodes[0].entry={id:'e1',hash:''};
 const p=scenePlan(s,sceneEvaluate(s,msgs));assert.deepEqual(sceneHidePlan(s,p,msgs,{injected:true}).hide,[]);
 s.settings.protectRecent=10;const plan=sceneHidePlan(s,scenePlan(s,sceneEvaluate(s,msgs)),msgs.slice(0,15),{injected:true});assert.deepEqual(plan.hide,['m1','m2','m3','m4','m5']);
 // Not injected (book detached or deleted), or no entry written for the node: nothing is hidden.
 assert.deepEqual(sceneHidePlan(s,scenePlan(s,sceneEvaluate(s,msgs)),msgs.slice(0,15)).hide,[]);
 s.nodes[0].entry=null;assert.deepEqual(sceneHidePlan(s,scenePlan(s,sceneEvaluate(s,msgs)),msgs.slice(0,15),{injected:true}).hide,[]);
});
// ---- LumiBooks, permission, branch, world-info guard -------------------------------
test('LumiBooks in the same chat: warning and auto-hide locked (no hide calls)',async()=>{
 const f=sceneFake({messages:makeMessages(40)}),s=svc(f);
 await recordApprove(s,f,[[1,20]]);let v=await load(s);
 v=(await as(s,{type:'sceneSettings',autoHide:true,sceneRevision:v.revision})).chronicle;const calls=f.calls.hidden.length;assert.ok(calls>0);
 f.meta.a.lumibooks_book_id='lb-1';
 v=await load(s);assert.equal(v.lumibooks,true);
 await recordApprove(s,f,[[21,25]]);assert.equal(f.calls.hidden.length,calls,'frozen while LumiBooks is present');
 // Turning auto-hide off still returns every message we hid, LumiBooks or not.
 v=await load(s);v=(await as(s,{type:'sceneSettings',autoHide:false,sceneRevision:v.revision})).chronicle;
 assert.equal(v.hidden,0);assert.deepEqual(f.msgs.a.filter(m=>m.extra?.hidden).map(m=>m.id),[]);
 const f2=sceneFake(),s2=svc(f2);f2.meta.a.lumibooks_book_id='lb-1';
 v=await load(s2);await assert.rejects(()=>as(s2,{type:'sceneSettings',autoHide:true,sceneRevision:v.revision}),/LumiBooks/);
});
test('without world_books permission the scene tab only explains; nothing is recorded or written',async()=>{
 const f=sceneFake(),s=svc(f);f.grants.delete('world_books');
 const v=await load(s);assert.equal(v.permission,false);
 await assert.rejects(()=>rec(s,1,20),/권한 필요: world_books/);assert.equal(f.calls.generate.length,0);assert.equal(f.calls.list,0);
});
async function branchSetup(){
 const f=sceneFake(),s=svc(f);
 await recordApprove(s,f,[[1,20],[21,40],[41,60]]);
 const parentBook=f.calls.bookCreate[0].id;
 // Host branch at message 45: metadata copied as is, messages copied with new IDs.
 f.meta.b={...structuredClone(f.meta.a),branched_from:'a',branch_at_message:'m45'};f.names.b='채팅이름표본 — Branch at #45';
 f.msgs.b=f.msgs.a.slice(0,45).map((m,i)=>({...structuredClone(m),id:'b'+(i+1)}));
 return {f,s,parentBook};
}
test('branch: the parent book is detached, the child gets its own book with verified scenes, and the parent is never written',async()=>{
 const {f,s,parentBook}=await branchSetup();
 const parentEntries=JSON.stringify(entriesOf(f).filter(e=>e.world_book_id===parentBook));const mark=[f.calls.entryCreate.length,f.calls.entryUpdate.length,f.calls.entryDelete.length];
 const parentStored=JSON.stringify(f.db.get('chats/a/chronicle.json'));
 const v=(await s.run({type:'sceneLoad',chatId:'b'},'owner')).chronicle;
 assert.deepEqual(v.nodes.map(x=>x.label),['장면 1–20','장면 21–40'],'41–60 crosses the branch point');
 assert.equal(f.calls.bookCreate.length,2);const own=f.calls.bookCreate[1];assert.deepEqual(own.metadata,{memory_cabinet_chat_id:'b'});
 assert.deepEqual(f.meta.b.chat_world_book_ids,[own.id]);assert.equal(f.meta.b.loom_summary,'루미버스 요약 원문');
 assert.deepEqual(f.meta.a.chat_world_book_ids,[parentBook]);
 assert.equal(JSON.stringify(entriesOf(f).filter(e=>e.world_book_id===parentBook)),parentEntries);
 const later=[...f.calls.entryCreate.slice(mark[0]),...f.calls.entryUpdate.slice(mark[1]),...f.calls.entryDelete.slice(mark[2])];
 assert.equal(f.calls.entryCreate.length-mark[0],2);assert.ok(later.length&&later.every(c=>c.bookId===own.id),'child writes go to its own book only');
 assert.equal(JSON.stringify(f.db.get('chats/a/chronicle.json')),parentStored);
 assert.ok(entriesOf(f).filter(e=>e.world_book_id===own.id).every(e=>e.extensions.memory_cabinet.chatId==='b'));
});
test('world-info guard: a parent book copied into a branch, stale entries and errors are turned off; valid ones pass',async()=>{
 const {f,s,parentBook}=await branchSetup();
 const parentEntries=entriesOf(f).filter(e=>e.world_book_id===parentBook);
 const ctx=(chatId,messages,list)=>({chatId,userId:'owner',messages,entries:list,chatMetadata:{}});
 let r=await s.worldInfoGuard(ctx('b',f.msgs.b,parentEntries));assert.deepEqual(r.disabled.sort(),parentEntries.map(e=>e.id).sort(),'before the branch opens: parent entries off');
 r=await s.worldInfoGuard(ctx('a',f.msgs.a,parentEntries));assert.equal(r,undefined,'parent chat: all valid');
 const changed=structuredClone(f.msgs.a);changed[3].content='편집됨';
 r=await s.worldInfoGuard(ctx('a',changed,parentEntries));assert.deepEqual(r.disabled,[byLabel(f,'장면 1–20').id]);
 r=await s.worldInfoGuard(ctx('a',f.msgs.a,[...parentEntries,{id:'user-entry',extensions:{}}]));assert.equal(r,undefined,'entries we did not write are never touched');
 r=await s.worldInfoGuard({...ctx('a',f.msgs.a,parentEntries),userId:'attacker'});assert.equal(r.disabled.length,parentEntries.length);
});
// ---- Korean model-facing text --------------------------------------------------------
test('every model-facing instruction is Korean; only JSON keys, layer and action ids stay English',()=>{
 const allowed=new Set(['JSON','layer','text','scope','promises','anchors','elements','scenes','flows','wiki','public','unknown','action','update','complete','archive','target','reason','title','body','keywords','YYYY','MM','DD','HH','mm','id']);
 for(const [name,prompt] of Object.entries({ANALYSIS_PROMPT,HEALTH_PROMPT,LOOM_ANALYSIS_RULES,LOOM_HEALTH_RULES,SCENE_PROMPT:scenePrompt(SCENE_PROMPT,600),SCENE_MERGE_PROMPT:scenePrompt(SCENE_MERGE_PROMPT,900)})){
  const words=(prompt.match(/[A-Za-z]{2,}/g)||[]).filter(w=>!allowed.has(w));
  assert.deepEqual(words,[],name+' has English words: '+words.join(','));
  assert.ok((prompt.match(/[가-힣]/g)||[]).length>100,name);
 }
});
test('built dist backend: record, approve and merge-undo behave like the source (one book, body-only entries)',async()=>{
 const {createService:distService}=await import('../dist/backend.js');
 const f=sceneFake(),s=distService(f.api,{autoDelayMs:1});
 await recordApprove(s,f,[[1,20],[21,40]]);let v=await load(s);
 await as(s,{type:'sceneMerge',ids:v.nodes.map(x=>x.id),mode:'raw',connection:'conn',sceneRevision:v.revision});v=(await approveLast(s)).chronicle;
 assert.equal(f.calls.bookCreate.length,1);assert.equal(byLabel(f,'장 1–40').content,'[이야기 3일차 밤] 민수와 지아가 창고에서 공책과 열쇠를 맞바꾼 뒤 함께 도망쳤다.');
 await as(s,{type:'sceneUnmerge',id:v.nodes.find(x=>x.kind==='chapter').id,sceneRevision:v.revision});
 assert.deepEqual(entriesOf(f).filter(e=>!e.disabled).map(e=>e.comment).sort(),['장면 1–20','장면 21–40']);
 const {SCENE_PROMPT:distPrompt}=await import('../dist/backend.js');assert.equal(distPrompt,SCENE_PROMPT);
});
test('background syncs (hiding after a reply) do not make an open panel out of date; panel edits do',async()=>{
 const f=sceneFake({messages:makeMessages(25)}),s=svc(f);
 await recordApprove(s,f,[[1,20]]);let v=await load(s);
 v=(await as(s,{type:'sceneSettings',autoHide:true,sceneRevision:v.revision})).chronicle;assert.equal(v.hidden,15);
 f.msgs.a.push(...makeMessages(30).slice(25));// five more turns: 16–20 leave the protected tail
 const r=await s.onSceneEvent({chatId:'a'},'owner');assert.ok(r.chronicle.hidden>v.hidden);assert.equal(r.chronicle.revision,v.revision);
 await rec(s,21,30);const w=await load(s);
 await as(s,{type:'sceneApprove',id:w.candidates[0].id,scope:'unknown',sceneRevision:w.revision});
 await assert.rejects(()=>as(s,{type:'sceneSettings',budget:500,sceneRevision:w.revision}),/그사이 바뀌었습니다/);
});
