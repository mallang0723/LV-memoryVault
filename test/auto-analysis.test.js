import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createService} from '../src/service.js';
import {start} from '../src/backend.js';
import {setup} from '../src/frontend.js';
import {MAX_INPUT_CHARS} from '../src/core.js';

const msg=(i,user,extra={})=>({id:'m'+i,is_user:user,content:(user?'USER_':'BOT_')+i,send_date:1760000000+i,extra});
// Alternating user/assistant turns: n user messages and n replies.
const turns=(n,start=0)=>Array.from({length:n*2},(_,k)=>msg(start+k,k%2===0));
function fake(messages=[]){
 const db=new Map(),calls=[],reads=[],pushed=[];let reply='[{"layer":"promises","text":"[이야기 1일차] 약속","scope":"public"}]';
 const api={permissions:{has:()=>true},
  chats:{getActive:async()=>({id:'a'}),get:async(id,u)=>u==='owner'&&id==='a'?{id,metadata:{}}:null},
  userStorage:{exists:async k=>{reads.push(k);return db.has(k);},getJson:async k=>{reads.push(k);return structuredClone(db.get(k));},setJson:async(k,v)=>{db.set(k,structuredClone(v));}},
  chat:{getMessages:async()=>structuredClone(f.messages)},
  connections:{get:async id=>({id,name:'n',provider:'p',model:'m'}),list:async()=>[]},
  generate:{raw:async input=>{calls.push(input);if(typeof reply==='function')return reply(input);return {content:reply};}},
  sendToFrontend:(m,u)=>pushed.push({m,u})};
 const f={api,db,calls,reads,pushed,messages,setReply:r=>{reply=r;}};return f;
}
const enable=(s,every=3,extra={})=>s.run({type:'autoSettings',chatId:'a',enabled:true,every,mode:'raw',connection:'c1',timeZone:'Asia/Seoul',...extra},'owner');
const ended=(s,type='normal',user='owner')=>s.onGenerationEnded({chatId:'a',messageId:'x',generationType:type},user);

test('automatic analysis is off by default: replies never call the model',async()=>{
 const f=fake(turns(20)),s=createService(f.api,{autoDelayMs:0});
 assert.deepEqual((await s.run({type:'load',chatId:'a'},'owner')).auto,{enabled:false,every:10,mode:'raw',connection:'',last:null});
 assert.equal((await ended(s)).skip,'off');assert.equal(f.calls.length,0);
});

test('counts user messages since the marker and analyzes exactly that range',async()=>{
 const f=fake(turns(5)),s=createService(f.api,{autoDelayMs:0});
 await enable(s,3);
 // Enabling starts counting now: the existing history is never sent.
 f.messages.push(...turns(2,10));assert.equal((await ended(s)).skip,'count');assert.equal(f.calls.length,0);
 f.messages.push(...turns(1,20));const r=await ended(s);assert.equal(r.ok,true);assert.equal(f.calls.length,1);
 const input=f.calls[0].messages[1].content;
 for(const i of [10,11,12,13,20,21])assert.ok(input.includes('_'+i),i);
 assert.ok(!/(USER|BOT)_[0-9](?![0-9])/.test(input));
 const data=f.db.get('chats/a/data.json');assert.equal(data.items.length,0);assert.equal(data.candidates.length,1);assert.equal(data.candidates[0].scope,'unknown');
 assert.deepEqual(data.candidates[0].evidence.map(e=>e.id),['m10','m11','m12','m13','m20','m21']);
 const auto=f.db.get('chats/a/auto.json');assert.equal(auto.marker.id,'m21');assert.equal(auto.last.ok,true);assert.equal(auto.last.added,1);
 // Marker advanced: the next reply starts a new count.
 assert.equal((await ended(s)).skip,'count');assert.equal(f.calls.length,1);
 assert.equal(f.pushed.at(-1).u,'owner');assert.equal(f.pushed.at(-1).m.event,'autoAnalysis');
});

test('swipes and regenerations do not count as user messages; bursts are coalesced',async()=>{
 const f=fake(turns(1)),s=createService(f.api,{autoDelayMs:5});
 await enable(s,3);f.messages.push(...turns(2,10));
 // A swipe adds a variant to the existing reply, not a message.
 const last=f.messages.at(-1);last.swipes=[last.content,'BOT_alt'];
 const results=await Promise.all([ended(s,'swipe'),ended(s,'regenerate'),ended(s,'swipe')]);
 assert.deepEqual(results.map(r=>r.skip),['debounced','debounced','count']);assert.equal(f.calls.length,0);
 assert.equal((await ended(s,'impersonate')).skip,'event');
 assert.equal((await s.onGenerationEnded({chatId:'a',error:'boom',generationType:'normal'},'owner')).skip,'event');
 assert.equal(f.calls.length,0);
});

test('one run per chat at a time (in-flight lock)',async()=>{
 const f=fake(turns(1)),s=createService(f.api,{autoDelayMs:0});await enable(s,3);f.messages.push(...turns(3,10));
 let release;const gate=new Promise(r=>release=r);
 f.setReply(async()=>{await gate;return {content:'[]'};});
 const first=s.autoCheck('a','owner'),second=await s.autoCheck('a','owner');
 assert.equal(second.skip,'busy');release();await first;assert.equal(f.calls.length,1);
 // The chat queue stays usable while the model call is pending (the RP interceptor loads through it).
 f.messages.push(...turns(3,20));let unblock;const slow=new Promise(r=>unblock=r);f.setReply(async()=>{await slow;return {content:'[]'};});
 const running=s.autoCheck('a','owner');await new Promise(r=>setTimeout(r,5));
 const loaded=await s.run({type:'load',chatId:'a'},'owner');assert.ok(loaded.state);unblock();await running;
});

test('ownership failure: no storage read, no model call',async()=>{
 const f=fake(turns(10)),s=createService(f.api,{autoDelayMs:0});await enable(s,3);f.reads.length=0;
 f.api.chats.get=async()=>null;
 const r=await ended(s,'normal','owner');assert.equal(r.skip,'error');assert.match(r.error,/소유권/);
 assert.equal(f.reads.length,0);assert.equal(f.calls.length,0);
 assert.equal((await ended(s,'normal','bad user!')).skip,'invalid');
 await assert.rejects(()=>s.run({type:'autoPropose',chatId:'a'},'owner'),/알 수 없는 작업/);
 await assert.rejects(()=>s.run({type:'autoPrepare',chatId:'a'},'owner'),/알 수 없는 작업/);
});

test('failure is recorded once and waits for the next N user messages',async()=>{
 const f=fake(turns(1)),s=createService(f.api,{autoDelayMs:0});await enable(s,3);f.messages.push(...turns(3,10));
 f.api.generate.raw=async input=>{f.calls.push(input);throw Error('provider down');};
 const r=await ended(s);assert.match(r.error,/provider down/);
 const auto=f.db.get('chats/a/auto.json');assert.equal(auto.last.ok,false);assert.match(auto.last.error,/provider down/);assert.equal(auto.marker.id,'m1');
 for(let i=0;i<3;i++)assert.equal((await ended(s)).skip,'backoff');
 f.messages.push(...turns(2,20));assert.equal((await ended(s)).skip,'backoff');assert.equal(f.calls.length,1);
 f.messages.push(...turns(1,30));f.api.generate.raw=async input=>{f.calls.push(input);return {content:'[]'};};
 assert.equal((await ended(s)).ok,true);assert.equal(f.calls.length,2);
 // The retry covers everything since the last successful marker.
 assert.ok(f.calls[1].messages[1].content.includes('USER_10'));
 assert.equal(f.db.get('chats/a/auto.json').failed,null);
});

test('input over the limit keeps the most recent messages and moves the marker',async()=>{
 const f=fake(turns(1)),s=createService(f.api,{autoDelayMs:0});await enable(s,3);
 const big=n=>'x'.repeat(n);
 f.messages.push({id:'old',is_user:true,content:big(MAX_INPUT_CHARS-100),extra:{}},msg(50,false),msg(51,true),msg(52,false),msg(53,true),msg(54,false));
 assert.equal((await ended(s)).ok,true);const input=f.calls[0].messages[1].content;
 assert.ok(input.length<=MAX_INPUT_CHARS);assert.ok(!input.includes(big(100)));assert.ok(input.includes('USER_53'));
 const auto=f.db.get('chats/a/auto.json');assert.equal(auto.marker.id,'m54');assert.match(auto.last.text,/앞 1개는 60,000자 한도를 넘어 생략/);
 // A single message that can never fit is skipped with a notice, not retried forever.
 f.messages.push(msg(60,true),msg(61,false),msg(62,true),{id:'huge',is_user:true,content:big(MAX_INPUT_CHARS+10),extra:{}});
 assert.match((await ended(s)).error,/원문 크기 초과/);assert.equal(f.calls.length,1);
 assert.equal(f.db.get('chats/a/auto.json').marker.id,'huge');assert.equal(f.db.get('chats/a/auto.json').last.ok,false);
});

test('auto settings persist in their own file without touching revision or undo',async()=>{
 const f=fake(turns(2)),s=createService(f.api,{autoDelayMs:0});
 await s.run({type:'put',confirmPublic:true,chatId:'a',revision:0,item:{id:'x',layer:'elements',text:'one',scope:'public'}},'owner');
 const before=JSON.stringify(f.db.get('chats/a/data.json')),backup=JSON.stringify(f.db.get('chats/a/backup.json'));
 const on=await enable(s,7);assert.equal(on.auto.enabled,true);assert.equal(on.auto.every,7);assert.equal(on.state.revision,1);
 assert.equal(JSON.stringify(f.db.get('chats/a/data.json')),before);assert.equal(JSON.stringify(f.db.get('chats/a/backup.json')),backup);
 assert.equal(f.db.get('chats/a/auto.json').marker.id,'m3');
 // A stale revision does not matter: settings are not a memory edit.
 await s.run({type:'autoSettings',chatId:'a',revision:99,enabled:false,every:7},'owner');
 assert.equal((await createService(f.api).run({type:'load',chatId:'a'},'owner')).auto.enabled,false);
 assert.equal(JSON.stringify(f.db.get('chats/a/data.json')),before);
 for(const every of [2,101,'x',5.5])await assert.rejects(()=>enable(s,every),/3~100/);
 await assert.rejects(()=>enable(s,5,{connection:''}),/모델 연결/);
 await assert.rejects(()=>s.run({type:'autoSettings',chatId:'a',enabled:true,every:5,mode:'raw',connection:'c1'},'attacker'),/소유권/);
 // Danger keys are refused like any other request.
 await assert.rejects(()=>s.run(JSON.parse('{"type":"autoSettings","chatId":"a","enabled":false,"every":5,"__proto__":{}}'),'owner'),/위험한 키/);
});

test('backend subscribes to GENERATION_ENDED and unsubscribes on stop',()=>{
 let subscribed,off=0;const f=fake();
 const stop=start({...f.api,registerInterceptor:()=>()=>{},onFrontendMessage:()=>()=>{},on:(event,fn)=>{subscribed={event,fn};return ()=>off++;}});
 assert.equal(subscribed.event,'GENERATION_ENDED');assert.equal(typeof subscribed.fn,'function');stop();assert.equal(off,1);
});

test('panel: toggle needs a connection, sends interval, overview shows last run',()=>{
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);let listener;const sent=[];
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 const state={version:1,revision:0,items:[],candidates:[],undo:[]};
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state,auto:{enabled:false,every:10,mode:'raw',connection:'',last:null}});
 [...root.querySelectorAll('button')].find(x=>x.textContent==='설정').click();
 const toggle=root.querySelector('[aria-label="사용자 메시지 N개마다 자동 분석"]');assert.ok(toggle);assert.equal(toggle.checked,false);assert.equal(toggle.disabled,true);
 assert.match(root.textContent,/자동 전송됩니다/);
 const conn=sent.find(x=>x.type==='connections');listener({requestId:conn.requestId,ok:true,chatId:'a',state,connections:[{id:'c1',name:'모델',model:'m'}]});
 const select=root.querySelector('[aria-label="모델 연결"]');for(const o of select.querySelectorAll('option'))o.toggleAttribute('selected',o.getAttribute('value')==='c1');select.onchange();
 [...root.querySelectorAll('button')].find(x=>x.textContent==='설정').click();
 const t2=root.querySelector('[aria-label="사용자 메시지 N개마다 자동 분석"]');assert.equal(t2.disabled,false);t2.checked=true;
 root.querySelector('[aria-label="자동 분석 간격"]').value='5';root.querySelector('[data-auto-save]').click();
 const req=sent.at(-1);assert.equal(req.type,'autoSettings');assert.equal(req.enabled,true);assert.equal(req.every,5);assert.equal(req.connection,'c1');
 listener({requestId:req.requestId,ok:true,chatId:'a',state,auto:{enabled:true,every:5,mode:'raw',connection:'c1',last:{at:Date.now(),ok:false,added:0,text:'',note:'',error:'provider down'}}});
 [...root.querySelectorAll('button')].find(x=>x.textContent==='개요').click();
 const line=root.querySelector('[data-auto]');assert.ok(line);assert.equal(line.dataset.auto,'error');assert.match(line.textContent,/자동 분석: 마지막 실행 .* · 실패: provider down/);
 // Background completion for the open chat reloads it; other chats are ignored.
 const n=sent.length;listener({event:'autoAnalysis',chatId:'b',auto:{}});assert.equal(sent.length,n);
 listener({event:'autoAnalysis',chatId:'a',auto:{enabled:true,every:5,mode:'raw',connection:'c1',last:{at:Date.now(),ok:true,added:2,text:'대화 3–8 (6개)',note:'',error:''}}});assert.equal(sent.at(-1).type,'load');
 cleanup();
});
