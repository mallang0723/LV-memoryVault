import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {MAX_INPUT_CHARS,resolveScope,nextRange,sourceSummary} from '../src/core.js';
import {createService} from '../src/service.js';
import {setup} from '../src/frontend.js';

test('adjacent ranges stay separate spans; only overlapping ranges merge',()=>{
 const adj=resolveScope({scope:'range',ranges:[{start:21,end:30},{start:10,end:20}]},100);
 assert.deepEqual(adj.spans,[[10,20],[21,30]]);assert.ok(!adj.warnings.some(w=>/겹치는/.test(w)));
 const over=resolveScope({scope:'range',ranges:[{start:10,end:20},{start:15,end:25},{start:40,end:45}]},100);
 assert.deepEqual(over.spans,[[10,25],[40,45]]);assert.ok(over.warnings.some(w=>/겹치는 범위는 하나로 합쳤습니다/.test(w)));
 assert.equal(sourceSummary({scope:'range',ranges:[{start:10,end:20},{start:21,end:30}]},100).text,'대화 10–20, 21–30 (21개)');
});

test('next range continues after the previous row with the same length, clamped to the chat',()=>{
 assert.deepEqual(nextRange({start:'10',end:'20'},100),{start:'21',end:'31'});
 assert.deepEqual(nextRange({start:'10',end:'20'},25),{start:'21',end:'25'});
 assert.deepEqual(nextRange({start:'5',end:'5'},10),{start:'6',end:'6'});
 assert.deepEqual(nextRange({start:'20',end:'10'},100),{start:'21',end:'31'},'reversed rows are read as 10–20');
 assert.equal(nextRange({start:'10',end:'25'},25),null,'previous row already reaches the last message');
 assert.equal(nextRange({start:'10',end:'40'},25),null,'previous row outside the chat');
 for(const bad of [{start:'',end:'5'},{start:'0',end:'5'},{start:'1.5',end:'5'},undefined])assert.equal(nextRange(bad,25),null);
 assert.equal(nextRange({start:'1',end:'5'},0),null);assert.equal(nextRange({start:'1',end:'5'},undefined),null);
});

const fakeApi=(messages,reply=()=>'[]')=>{const db=new Map(),calls=[];return {calls,permissions:{has:()=>true},chats:{getActive:async()=>({id:'a'}),get:async(id,u)=>u==='owner'&&id==='a'?{id,metadata:{}}:null},userStorage:{exists:async k=>db.has(k),getJson:async k=>structuredClone(db.get(k)),setJson:async(k,v)=>{db.set(k,structuredClone(v));}},chat:{getMessages:async()=>structuredClone(messages)},connections:{get:async id=>({id,name:'n',provider:'p',model:'m'})},generate:{raw:async input=>{calls.push(input);return {content:reply(input)};}}};};
const chat=n=>Array.from({length:n},(_,i)=>({id:'m'+(i+1),content:'BODY_'+(i+1)}));
const ask=(s,revision,ranges)=>s.run({type:'analyze',chatId:'a',revision,mode:'raw',connection:'c1',source:{scope:'range',ranges}},'owner');

test('one request never sends separate ranges in one model call',async()=>{
 const api=fakeApi(chat(40)),s=createService(api);
 await assert.rejects(()=>ask(s,0,[{start:10,end:20},{start:21,end:30}]),/범위 여러 개를 한 번에 분석하지 않습니다/);
 assert.equal(api.calls.length,0);
 // Overlapping rows are one span and one call.
 await ask(s,0,[{start:10,end:20},{start:15,end:25}]);assert.equal(api.calls.length,1);
 const input=api.calls[0].messages[1].content;assert.ok(input.includes('BODY_10')&&input.includes('BODY_25')&&!input.includes('BODY_26')&&!input.includes('BODY_9\n'));
});

test('each range call records its own range in the candidate source and evidence',async()=>{
 const api=fakeApi(chat(40),input=>JSON.stringify([{layer:'promises',text:'[시각 미상] '+(input.messages[1].content.includes('BODY_10')?'first':'second')}])),s=createService(api);
 const a=await ask(s,0,[{start:'10',end:'20'}]);
 const b=await ask(s,a.state.revision,[{start:'21',end:'30'}]);
 assert.equal(api.calls.length,2);
 assert.ok(api.calls[0].messages[1].content.includes('BODY_20')&&!api.calls[0].messages[1].content.includes('BODY_21'));
 assert.ok(api.calls[1].messages[1].content.includes('BODY_21')&&!api.calls[1].messages[1].content.includes('BODY_20'));
 const [first,second]=b.state.candidates;
 assert.equal(first.source,'선택 원문 모델 후보 · 대화 10–20 (11개)');assert.equal(second.source,'선택 원문 모델 후보 · 대화 21–30 (10개)');
 assert.deepEqual([first.evidence[0].index,first.evidence.at(-1).index],[9,19]);assert.deepEqual([second.evidence[0].index,second.evidence.at(-1).index],[20,29]);
});

test('a range over the input limit is split at message boundaries: one call per chunk, in order',async()=>{
 const big=chat(30).map((m,i)=>i>=20?{...m,content:'x'.repeat(8000)}:m);
 const api=fakeApi(big,()=>'[{"layer":"elements","text":"[1일차] 후보","scope":"public"}]'),s=createService(api);
 const out=await ask(s,0,[{start:21,end:30}]);
 assert.equal(api.calls.length,2,'80,000 characters → two chunks');
 for(const c of api.calls)assert.ok(c.messages[1].content.length<=MAX_INPUT_CHARS);
 assert.match(out.notice,/대화 21–30 → 21–27, 28–30으로 나눠 분석/);assert.equal(out.saved,true);
 const sources=[...new Set(out.state.candidates.map(x=>x.source))];assert.deepEqual(sources,['선택 원문 모델 후보 · 대화 21–27 (7개)','선택 원문 모델 후보 · 대화 28–30 (3개)']);
 for(const x of out.state.candidates)assert.ok(x.evidence.every(e=>x.source.includes('21–27')?e.index<=26:e.index>=27),'each candidate keeps its own chunk as evidence');
});
test('a single message over the limit is skipped with a note, never cut; a range of only that message is refused',async()=>{
 const big=chat(12).map((m,i)=>i===5?{...m,content:'y'.repeat(MAX_INPUT_CHARS+5)}:m);
 const api=fakeApi(big),s=createService(api);
 const out=await ask(s,0,[{start:1,end:12}]);
 assert.equal(api.calls.length,2);assert.ok(api.calls.every(c=>!c.messages[1].content.includes('yyyy')));
 assert.match(out.notice,/대화 1–12 → 1–5, 7–12으로 나눠 분석/);assert.match(out.notice,/메시지 6은 하나만으로 60,000자 한도를 넘어 건너뜀\(잘라 보내지 않음\)/);
 await assert.rejects(()=>ask(s,out.state.revision,[{start:6,end:6}]),/하나만으로도 60,000자 한도를 넘어/);assert.equal(api.calls.length,2);
});

const mount=()=>{
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);const sent=[];let listener;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 const st=(revision,candidates=[])=>({revision,items:[],candidates,undo:[]});
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state:st(0)});
 const button=text=>[...root.querySelectorAll('button')].find(x=>x.textContent===text);
 const click=text=>{const b=button(text);assert.ok(b,text);b.click();};
 const reply=extra=>listener({requestId:sent.at(-1).requestId,ok:true,chatId:'a',state:st(0),...extra});
 const type=(label,value)=>{const x=root.querySelector(`[aria-label="${label}"]`);assert.ok(x,label);x.value=value;x.oninput();};
 const value=label=>root.querySelector(`[aria-label="${label}"]`)?.value;
 const open=(total,hidden=[])=>{click('분석');reply({total,hidden});};
 const connect=()=>{click('설정');reply({connections:[{id:'c1',name:'A',model:'gpt-x'}]});const s=root.querySelector('[aria-label="모델 연결"]');for(const o of s.querySelectorAll('option'))o.toggleAttribute('selected',o.getAttribute('value')==='c1');s.onchange();click('분석');};
 const run=()=>root.querySelector('[data-run]'),status=()=>root.querySelector('[role=status]').textContent,detail=()=>{const m=root.querySelector('[data-status-more]');if(m&&m.getAttribute('aria-expanded')!=='true')m.click();return root.querySelector('[data-status-detail]')?.textContent||'';};
 return {root,sent,listener,click,button,reply,type,value,open,connect,run,status,detail,st,cleanup};
};
const ranges=(v,list)=>{v.click('범위');list.forEach(([a,b],k)=>{if(k)v.click('+ 범위 추가');v.type('범위 '+(k+1)+' 시작',String(a));v.type('범위 '+(k+1)+' 끝',String(b));});};

test('+ 범위 추가 pre-fills from the previous row like Marinara',()=>{
 const v=mount();v.open(100);v.click('범위');
 assert.equal(v.value('범위 1 끝'),'100');
 const add=()=>v.button('+ 범위 추가');
 assert.ok(add().disabled,'the default row already ends at the last message');
 assert.match(v.root.querySelector('[data-add-hint]').textContent,/대화 끝\(100\)까지라/);
 v.type('범위 1 시작','10');v.type('범위 1 끝','20');
 assert.equal(add().disabled,false,'typing re-enables it without a re-render');assert.equal(v.root.querySelector('[data-add-hint]').hidden,true);
 v.click('+ 범위 추가');assert.equal(v.value('범위 2 시작'),'21');assert.equal(v.value('범위 2 끝'),'31');
 v.click('+ 범위 추가');assert.equal(v.value('범위 3 시작'),'32');assert.equal(v.value('범위 3 끝'),'42');
 v.type('범위 3 끝','95');v.click('+ 범위 추가');assert.equal(v.value('범위 4 시작'),'96');assert.equal(v.value('범위 4 끝'),'100','clamped to the last message');
 assert.ok(add().disabled);
 v.cleanup();
});

test('two ranges run as two calls in order, with progress, and a failed range keeps the other result',()=>{
 const v=mount();v.open(40);v.connect();ranges(v,[[10,20],[21,30]]);
 const before=v.sent.length;v.run().click();
 let req=v.sent.at(-1);assert.equal(v.sent.length,before+1);
 assert.equal(req.type,'analyze');assert.deepEqual(req.source,{scope:'range',ranges:[{start:'10',end:'20'}]});assert.equal(req.connection,'c1');
 assert.equal(v.run().textContent,'범위 1/2 분석 중…');assert.ok(v.run().disabled);assert.match(v.status(),/범위 1\/2 분석 중… \(대화 10–20\)/);
 v.run().click();assert.equal(v.sent.length,before+1,'no second run while one is going');
 v.reply({saved:true,added:3,state:v.st(1,[{id:'c',layer:'promises',text:'x',scope:'unknown'}]),notice:'대화 10–20 (11개) 분석 · 후보 3개 추가'});
 req=v.sent.at(-1);assert.equal(v.sent.length,before+2);
 assert.deepEqual(req.source,{scope:'range',ranges:[{start:'21',end:'30'}]});assert.equal(req.revision,1,'next range uses the saved revision');
 assert.equal(v.run().textContent,'범위 2/2 분석 중…');assert.ok(v.run().disabled);
 v.listener({requestId:req.requestId,ok:false,error:'모델 응답을 JSON 배열로 해석하지 못했습니다.'});
 assert.equal(v.sent.length,before+2);
 assert.equal(v.status(),'2개 범위 중 1개 성공 (후보 3개 추가) · 1개 실패 (모델 응답을 JSON 배열로 해석하지 못했습니다) · 검토 대기에서 확인 후 승인하세요');
 assert.equal(v.detail(),'2개 범위 중 1개 성공 (후보 3개 추가) · 1개 실패 (모델 응답을 JSON 배열로 해석하지 못했습니다) · 검토 대기에서 확인 후 승인하세요\n\n범위 2 (대화 21–30) – 모델 응답을 JSON 배열로 해석하지 못했습니다.');
 assert.ok(v.root.querySelector('[data-tab="overview"][aria-current="page"]'),'opens the review queue');
 v.click('분석');assert.equal(v.run().textContent,'분석');assert.equal(v.run().disabled,false);
 v.cleanup();
});

test('a failure in the first range does not stop the next one',()=>{
 const v=mount();v.open(40);v.connect();ranges(v,[[21,30],[10,20]]);v.run().click();
 let req=v.sent.at(-1);assert.deepEqual(req.source.ranges,[{start:'10',end:'20'}],'ranges run in chat order');
 v.listener({requestId:req.requestId,ok:false,error:'원문 크기 초과: 대화 10–20 (11개) 입력 70,000자 / 한도 60,000자. 이 범위를 더 작은 범위 여러 개로 나눠서 분석하세요.'});
 req=v.sent.at(-1);assert.deepEqual(req.source.ranges,[{start:'21',end:'30'}]);assert.equal(req.revision,0);
 v.reply({saved:true,added:2,state:v.st(1),notice:'대화 21–30 (10개) 분석 · 후보 2개 추가'});
 assert.match(v.status(),/^2개 범위 중 1개 성공 \(후보 2개 추가\) · 1개 실패 \(원문 크기 초과\)/);assert.match(v.detail(),/범위 1 \(대화 10–20\) – 원문 크기 초과/);
 v.cleanup();
});

test('all ranges failing reports each and stays on the analysis view',()=>{
 const v=mount();v.open(40);v.connect();ranges(v,[[1,5],[6,10]]);v.run().click();
 v.listener({requestId:v.sent.at(-1).requestId,ok:false,error:'A'});v.listener({requestId:v.sent.at(-1).requestId,ok:false,error:'B'});
 assert.equal(v.status(),'2개 범위 모두 실패');assert.equal(v.detail(),'범위 1 (대화 1–5) – A\n범위 2 (대화 6–10) – B');
 v.root.querySelector('[data-status-close]').click();assert.equal(v.root.querySelector('.lv-status').hidden,true,'closed');assert.equal(v.status(),'');
 assert.equal(v.run().textContent,'분석');assert.equal(v.run().disabled,false);
 v.cleanup();
});

test('overlapping ranges and recent N stay a single call',()=>{
 const v=mount();v.open(40);v.connect();
 v.run().click();assert.deepEqual(v.sent.at(-1).source,{scope:'last',n:'20'});assert.equal(v.run().textContent,'분석 중…');
 v.reply({saved:true,added:0,notice:'대화 21–40 (20개) 분석 · 후보 0개 추가'});v.click('분석');
 ranges(v,[[10,20],[21,30]]);v.type('범위 2 시작','15');
 const before=v.sent.length;v.run().click();assert.equal(v.sent.length,before+1);
 assert.deepEqual(v.sent.at(-1).source,{scope:'range',ranges:[{start:'10',end:'20'},{start:'15',end:'30'}]});assert.equal(v.run().textContent,'분석 중…');
 v.cleanup();
});
