import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {MAX_INPUT_CHARS,sourceNumber,rangeStatus,rangeIds,effectiveSelection,recentIds,inputSize} from '../src/core.js';
import {createService} from '../src/service.js';
import {setup} from '../src/frontend.js';

// Visible list as the service returns it: index is the position in the full chat.
const visible=[{id:'a',content:'one',index:0},{id:'c',content:'three',index:2},{id:'d',content:'four',index:3},{id:'e',content:'five',index:4}];

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

test('ranges use full-chat numbers, skip hidden slots and union with manual ticks',()=>{
 assert.deepEqual(visible.map(sourceNumber),[1,3,4,5]);
 assert.equal(sourceNumber({id:'x'},6),7);
 assert.deepEqual(rangeIds(visible,[{start:2,end:3}],5),['c']);
 assert.deepEqual(rangeIds(visible,[{start:2,end:2}],5),[]);
 assert.deepEqual(rangeIds(visible,[{start:1,end:1},{start:4,end:9},{start:7,end:8}],5),['a','d','e']);
 assert.deepEqual(effectiveSelection(visible,[{start:4,end:5}],new Set(['a','d','gone']),5),['a','d','e']);
 assert.deepEqual(effectiveSelection(visible,[],new Set(),5),[]);
});

test('recent N takes the tail of the visible list and rejects bad counts',()=>{
 assert.deepEqual(recentIds(visible,2),['d','e']);
 assert.deepEqual(recentIds(visible,'20'),['a','c','d','e']);
 assert.deepEqual(recentIds(visible,0),[]);
 assert.deepEqual(recentIds(visible,'x'),[]);
});

test('input size mirrors the joined preview input',()=>{
 assert.equal(inputSize(visible,['a','c']),'one\n\nthree'.length);
 assert.equal(inputSize(visible,[]),0);
 assert.equal(MAX_INPUT_CHARS,60000);
});

const fakeApi=messages=>{const db=new Map();return {permissions:{has:()=>true},chats:{getActive:async()=>({id:'a'}),get:async(id,u)=>u==='owner'&&id==='a'?{id,metadata:{}}:null},userStorage:{exists:async k=>db.has(k),getJson:async k=>structuredClone(db.get(k)),setJson:async(k,v)=>{db.set(k,structuredClone(v));}},chat:{getMessages:async()=>structuredClone(messages)},generate:{raw:async()=>{throw Error('no model calls in tests');}}};};

test('sources number messages by full-chat position and exclude hidden ones',async()=>{
 const s=createService(fakeApi([{id:'m1',content:'a',extra:{}},{id:'m2',content:'b',extra:{hidden:true}},{id:'m3',content:'c'}]));
 const r=await s.run({type:'sources',chatId:'a'},'owner');
 assert.equal(r.total,3);assert.deepEqual(r.messages,[{id:'m1',content:'a',index:0},{id:'m3',content:'c',index:2}]);
});

test('preview rejects selections over the input cap with the limit in the message',async()=>{
 const big='x'.repeat(40000),s=createService(fakeApi([{id:'m1',content:big},{id:'m2',content:big}]));
 await assert.rejects(()=>s.run({type:'preview',chatId:'a',ids:['m1','m2'],mode:'raw',connection:'c1'},'owner'),/원문 크기 초과.*80,002자.*60,000자/);
 const ok=await s.run({type:'preview',chatId:'a',ids:['m1'],mode:'raw',connection:'c1'},'owner');assert.equal(ok.preview.input.length,40000);
});

const mount=()=>{
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);const sent=[];let listener,switcher;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:(_,fn)=>{switcher=fn;return()=>{};}}});
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state:{revision:0,items:[],candidates:[],undo:[]}});
 const click=text=>[...root.querySelectorAll('button')].find(x=>x.textContent===text).click();
 const load=(messages,total)=>{click('약속');click('원문에서 정리');click('원문 목록 읽기');listener({requestId:sent.at(-1).requestId,ok:true,chatId:'a',state:{revision:0,items:[],candidates:[],undo:[]},messages,total});};
 const count=()=>Number(root.querySelector('[data-selected]').dataset.selected);
 const preview=()=>{click('입력·모델 미리보기');return sent.at(-1);};
 return {root,sent,click,load,count,preview,cleanup,switchTo:id=>switcher({chatId:id}),reply:extra=>listener({requestId:sent.at(-1).requestId,ok:true,chatId:'a',state:{revision:0,items:[],candidates:[],undo:[]},...extra})};
};

test('analysis view numbers by chat position and explains hidden exclusion',()=>{
 const v=mount();v.load(visible,5);
 const labels=[...v.root.querySelectorAll('.lv-source b')].map(x=>x.textContent);
 assert.deepEqual(labels,['대화 1','대화 3','대화 4','대화 5']);
 assert.match(v.root.textContent,/전체 5개 중 숨김 메시지 1개는 분석에서 제외/);
 assert.match(v.root.textContent,/메시지 0개 선택됨/);v.cleanup();
});

test('select all, clear, recent N and shift range feed the preview ids',()=>{
 const v=mount();v.load(visible,5);
 v.click('전체 선택');assert.equal(v.count(),4);assert.deepEqual(v.preview().ids,['a','c','d','e']);
 v.click('선택 해제');assert.equal(v.count(),0);
 v.root.querySelector('[aria-label="최근 메시지 개수"]').value='2';v.click('최근 N개 선택');
 assert.equal(v.count(),2);assert.deepEqual(v.preview().ids,['d','e']);
 v.click('선택 해제');
 const box=n=>v.root.querySelector(`[aria-label="대화 ${n} 선택"]`);
 box(1).checked=true;box(1).onclick({shiftKey:false});
 box(5).checked=true;box(5).onclick({shiftKey:true});
 assert.equal(v.count(),4);
 box(4).checked=false;box(4).onclick({shiftKey:false});
 assert.deepEqual(v.preview().ids,['a','c','e']);
 v.cleanup();
});

test('ranges add, warn when outside the chat, remove, and persist per chat',()=>{
 const v=mount();v.load(visible,5);
 v.click('+ 범위 추가');assert.equal(v.count(),4);
 const set=(label,value)=>{const x=v.root.querySelector(`[aria-label="${label}"]`);x.value=value;x.onchange();};
 set('범위 1 시작','3');set('범위 1 끝','4');assert.equal(v.count(),2);
 assert.ok(v.root.querySelector('[aria-label="대화 3 선택"]').disabled);
 v.root.querySelector('[aria-label="대화 1 선택"]').checked=true;v.root.querySelector('[aria-label="대화 1 선택"]').onclick({});
 assert.deepEqual(v.preview().ids,['a','c','d']);
 v.click('+ 범위 추가');set('범위 2 시작','8');set('범위 2 끝','9');
 assert.match(v.root.textContent,/이 범위는 채팅 기록 밖입니다/);assert.equal(v.count(),3);
 v.root.querySelector('[aria-label="범위 2 삭제"]').click();assert.ok(!v.root.textContent.includes('채팅 기록 밖'));
 v.switchTo('b');v.switchTo('a');v.reply({messages:visible,total:5});

 assert.equal(v.root.querySelector('[aria-label="범위 1 시작"]').value,'3');assert.equal(v.count(),2);
 v.click('선택 해제');assert.equal(v.root.querySelector('[aria-label="범위 1 시작"]'),null);v.cleanup();
});

test('long previews collapse and expand without toggling the checkbox',()=>{
 const v=mount();v.load([{id:'a',content:'line\n'.repeat(10),index:0}],1);
 const text=v.root.querySelector('.lv-source-text');assert.ok(text.classList.contains('is-clipped'));
 text.onclick();assert.ok(!text.classList.contains('is-clipped'));
 assert.equal(v.root.querySelector('[aria-label="대화 1 선택"]').checked,false);assert.equal(v.count(),0);v.cleanup();
});

test('selections over the input cap show the limit and block the preview request',()=>{
 const v=mount();const big='x'.repeat(31000);v.load([{id:'a',content:big,index:0},{id:'b',content:big,index:1}],2);
 v.click('전체 선택');assert.match(v.root.textContent,/62,002 \/ 60,000자/);assert.match(v.root.textContent,/입력 한도\(60,000자\)를 넘었습니다/);
 const before=v.sent.length,btn=[...v.root.querySelectorAll('button')].find(x=>x.textContent==='입력·모델 미리보기');
 assert.ok(btn.disabled);btn.click();assert.equal(v.sent.length,before);
 v.click('선택 해제');
 assert.ok(![...v.root.querySelectorAll('button')].find(x=>x.textContent==='입력·모델 미리보기').disabled);v.cleanup();
});
