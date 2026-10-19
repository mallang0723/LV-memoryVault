import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {MAX_INPUT_CHARS,MAX_RANGES,rangeStatus,resolveScope,sourceSummary,selectSource,countOf} from '../src/core.js';
import {createService} from '../src/service.js';
import {setup} from '../src/frontend.js';

test('range status validates integers, order and clamps to the chat length',()=>{
 assert.deepEqual(rangeStatus({start:'2',end:'4'},5),{ok:true,start:2,end:4});
 assert.equal(rangeStatus({start:'',end:'3'},5).ok,false);
 assert.equal(rangeStatus({start:'1.5',end:'3'},5).ok,false);
 assert.equal(rangeStatus({start:0,end:3},5).ok,false);
 assert.match(rangeStatus({start:4,end:2},5).warning,/시작 번호가 끝 번호보다/);
 const outside=rangeStatus({start:9,end:12},5);assert.equal(outside.ok,false);assert.match(outside.warning,/이 범위는 채팅 기록 밖입니다/);
 const clamped=rangeStatus({start:4,end:99},5);assert.equal(clamped.ok,true);assert.equal(clamped.end,5);assert.match(clamped.warning,/4 - 5까지만/);
 assert.equal(rangeStatus({start:1,end:2},0).ok,false);
});

test('scopes resolve to merged spans with Korean errors for anything unusable',()=>{
 assert.deepEqual(resolveScope({scope:'last',n:'20'},141).spans,[[122,141]]);
 const all=resolveScope({scope:'last',n:50},10);assert.deepEqual(all.spans,[[1,10]]);assert.match(all.warnings[0],/10개뿐이라 전체/);
 for(const n of [0,'',' ','x',-1,1.5])assert.match(resolveScope({scope:'last',n},10).error,/1 이상의 정수/);
 assert.match(resolveScope({scope:'last',n:5},0).error,/대화가 아직 없습니다/);
 assert.match(resolveScope({},10).error,/방식/);
 assert.match(resolveScope({scope:'range',ranges:[]},10).error,/하나 이상/);
 assert.match(resolveScope({scope:'range',ranges:Array.from({length:MAX_RANGES+1},()=>({start:1,end:1}))},10).error,/20개까지/);
 assert.match(resolveScope({scope:'range',ranges:[{start:1,end:2},{start:5,end:3}]},10).error,/^범위 2: 시작 번호가 끝 번호보다/);
 assert.match(resolveScope({scope:'range',ranges:[{start:20,end:30}]},10).error,/범위 1: 이 범위는 채팅 기록 밖/);
 const merged=resolveScope({scope:'range',ranges:[{start:8,end:20},{start:1,end:3},{start:2,end:5},{start:6,end:6}]},10);
 assert.deepEqual(merged.spans,[[1,5],[6,6],[8,10]]);assert.ok(merged.warnings.some(w=>/겹치는 범위/.test(w)));assert.ok(merged.warnings.some(w=>/범위 1: 끝 번호가 채팅 기록 밖/.test(w)));
});

test('summary line counts positions and leaves hidden messages out',()=>{
 assert.equal(sourceSummary({scope:'last',n:22},141).text,'대화 120–141 (22개)');
 assert.equal(sourceSummary({scope:'range',ranges:[{start:1,end:3},{start:7,end:7}]},10,[2]).text,'대화 1–3, 7 (3개) · 숨김 1개 제외');
 assert.match(sourceSummary({scope:'range',ranges:[{start:2,end:2}]},10,[2]).error,/모두 숨김/);
});

test('service selection uses host order, skips hidden and keeps full-chat indexes',()=>{
 const chat=[{id:'a',content:'1'},{id:'b',content:'2',extra:{hidden:true}},{id:'c',content:'3'},{id:'d',content:'4'}];
 assert.deepEqual(countOf(chat),{total:4,hidden:[2]});
 const s=selectSource(chat,{scope:'last',n:3});
 assert.deepEqual(s.picked.map(x=>[x.m.id,x.index]),[['c',2],['d',3]]);assert.equal(s.text,'대화 2–4 (2개) · 숨김 1개 제외');
 assert.throws(()=>selectSource(chat,{scope:'range',ranges:[{start:2,end:2}]}),/모두 숨김/);
 assert.equal(MAX_INPUT_CHARS,60000);
});

const fakeApi=messages=>{const db=new Map(),calls=[];return {calls,permissions:{has:()=>true},chats:{getActive:async()=>({id:'a'}),get:async(id,u)=>u==='owner'&&id==='a'?{id,metadata:{}}:null},userStorage:{exists:async k=>db.has(k),getJson:async k=>structuredClone(db.get(k)),setJson:async(k,v)=>{db.set(k,structuredClone(v));}},chat:{getMessages:async()=>structuredClone(messages)},connections:{get:async id=>({id,name:'n',provider:'p',model:'m'})},generate:{raw:async input=>{calls.push(input);return {content:'[]'};}}};};

test('count returns only the total and hidden positions, never message text',async()=>{
 const s=createService(fakeApi([{id:'m1',content:'BODY_ONE',extra:{}},{id:'m2',content:'BODY_TWO',extra:{hidden:true}},{id:'m3',content:'BODY_THREE'}]));
 const r=await s.run({type:'count',chatId:'a'},'owner');
 assert.equal(r.total,3);assert.deepEqual(r.hidden,[2]);assert.ok(!JSON.stringify(r).includes('BODY_'));
 await assert.rejects(()=>s.run({type:'sources',chatId:'a'},'owner'));
});

test('one analyze request reads only the chosen range and records evidence by chat position',async()=>{
 const api=fakeApi(Array.from({length:6},(_,i)=>({id:'m'+i,content:'BODY_'+i,extra:i===4?{hidden:true}:{}}))),s=createService(api);
 const r=await s.run({type:'analyze',chatId:'a',revision:0,mode:'raw',connection:'c1',source:{scope:'range',ranges:[{start:4,end:9}]}},'owner');
 const input=api.calls[0].messages[1].content;
 assert.ok(input.includes('BODY_3')&&input.includes('BODY_5'));
 assert.ok(!input.includes('BODY_0')&&!input.includes('BODY_2')&&!input.includes('BODY_4'));
 assert.equal(r.total,6);assert.match(r.notice,/^대화 4–6 \(2개\) · 숨김 1개 제외 분석/);
});

const mount=()=>{
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);const sent=[];let listener,switcher;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:(_,fn)=>{switcher=fn;return()=>{};}}});
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state:{revision:0,items:[],candidates:[],undo:[]}});
 const button=text=>[...root.querySelectorAll('button')].find(x=>x.textContent===text);
 const click=text=>{const b=button(text);assert.ok(b,text);b.click();};
 const reply=extra=>listener({requestId:sent.at(-1).requestId,ok:true,chatId:'a',state:{revision:0,items:[],candidates:[],undo:[]},...extra});
 const open=(total,hidden=[])=>{click('분석');assert.equal(sent.at(-1).type,'count');reply({total,hidden});};
 const summary=()=>root.querySelector('[data-source-summary]').textContent;
 const type=(label,value)=>{const x=root.querySelector(`[aria-label="${label}"]`);assert.ok(x,label);x.value=value;x.oninput();};
 const connect=()=>{click('설정');reply({connections:[{id:'c1',name:'A',model:'gpt-x'}]});const s=root.querySelector('[aria-label="모델 연결"]');for(const o of s.querySelectorAll('option'))o.toggleAttribute('selected',o.getAttribute('value')==='c1');s.onchange();click('분석');};
 return {root,sent,click,button,reply,open,summary,type,connect,cleanup,switchTo:id=>switcher({chatId:id})};
};

test('recent N is the default scope and the summary follows the typed number',()=>{
 const v=mount();v.open(141);
 assert.equal(v.summary(),'대화 122–141 (20개)');
 const n=v.root.querySelector('[aria-label="최근 메시지 개수"]');assert.equal(n.getAttribute('inputmode'),'numeric');
 v.type('최근 메시지 개수','22');assert.equal(v.summary(),'대화 120–141 (22개)');
 v.type('최근 메시지 개수','0');assert.match(v.root.textContent,/1 이상의 정수/);
 assert.ok(v.root.querySelector('[data-run]').disabled);
 v.cleanup();
});

test('ranges add, validate, merge, remove and persist per chat',()=>{
 const v=mount();v.open(10,[4]);
 v.click('범위');assert.equal(v.root.querySelector('[aria-label="범위 1 시작"]').value,'1');assert.equal(v.summary(),'대화 1–10 (9개) · 숨김 1개 제외');
 v.type('범위 1 시작','2');v.type('범위 1 끝','5');assert.equal(v.summary(),'대화 2–5 (3개) · 숨김 1개 제외');
 v.click('+ 범위 추가');v.type('범위 2 시작','4');v.type('범위 2 끝','6');
 assert.equal(v.summary(),'대화 2–6 (4개) · 숨김 1개 제외');assert.match(v.root.textContent,/겹치는 범위는 하나로 합쳤습니다/);
 v.type('범위 2 시작','30');v.type('범위 2 끝','40');assert.match(v.root.textContent,/범위 2: 이 범위는 채팅 기록 밖입니다/);
 assert.ok(v.root.querySelector('[data-run]').disabled);
 v.root.querySelector('[aria-label="범위 2 삭제"]').click();assert.equal(v.summary(),'대화 2–5 (3개) · 숨김 1개 제외');
 v.switchTo('b');v.reply({});v.switchTo('a');v.reply({});v.click('분석');
 assert.equal(v.root.querySelector('[aria-label="범위 1 시작"]').value,'2');assert.equal(v.summary(),'대화 2–5 (3개) · 숨김 1개 제외');
 v.cleanup();
});

test('one tap on 분석 sends the scope, never message IDs or text; needs a connection from settings',()=>{
 const v=mount();v.open(30);
 v.root.querySelector('[data-run]').click();
 assert.ok(!v.sent.some(x=>x.type==='analyze'));assert.match(v.root.textContent,/모델 연결을 먼저 고르세요/);
 assert.ok(v.root.querySelector('[aria-label="모델 연결"]'),'opens the settings tab');
 v.connect();v.root.querySelector('[data-run]').click();
 const req=v.sent.at(-1);assert.equal(req.type,'analyze');
 assert.deepEqual(req.source,{scope:'last',n:'20'});assert.equal(req.mode,'raw');assert.equal(req.connection,'c1');
 assert.ok(!('ids' in req)&&!('token' in req)&&!('confirm' in req));
 assert.equal(v.root.querySelector('[data-run]').textContent,'분석 중…');assert.ok(v.root.querySelector('[data-run]').disabled);
 v.reply({saved:true,total:30,hidden:[],notice:'대화 11–30 (20개) 분석 · 후보 0개 추가 · 검토 대기에서 확인 후 승인하세요'});
 assert.match(v.root.querySelector('[role=status]').textContent,/대화 11–30/);assert.ok(v.root.querySelector('[data-tab="overview"][aria-current="page"]'));
 v.click('분석');assert.equal(v.root.querySelector('[data-run]').textContent,'분석');
 v.cleanup();
});

test('model choice lives in the settings tab, not in the analysis view',()=>{
 const v=mount();v.open(5);
 assert.equal(v.root.querySelector('[aria-label="모델 연결"]'),null);assert.equal(v.root.querySelector('[aria-label="분석 모드"]'),null);
 assert.equal(v.button('입력·모델 미리보기'),undefined);
 v.click('설정');assert.ok(v.root.querySelector('[aria-label="모델 연결"]'));assert.ok(v.root.querySelector('[aria-label="분석 모드"]'));
 assert.match(v.root.textContent,/분석 버튼을 누르면 고른 범위의 원문이 이 연결로 바로 전송됩니다/);
 v.cleanup();
});

test('overview shows whether the latest reply got its memories',()=>{
 const v=mount();const shown=()=>v.root.querySelector('[data-injection]');
 assert.equal(shown().dataset.injection,'none');
 v.click('새로고침');v.reply({injection:{at:Date.now(),status:'skipped'}});
 assert.equal(shown().dataset.injection,'skipped');assert.match(shown().textContent,/기억을 넣지 못했습니다/);assert.ok(shown().classList.contains('lv-warning'));
 v.click('새로고침');v.reply({injection:{at:Date.now(),status:'injected',count:3}});
 assert.match(shown().textContent,/공개 기억 3개를 넣었습니다/);
 v.switchTo('b');v.reply({});assert.equal(shown().dataset.injection,'none');
 v.cleanup();
});
