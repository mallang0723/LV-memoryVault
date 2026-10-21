import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {sentStamp,sourceInput,validTimeZone,parseCandidates,normalizeCandidates,fingerprint,MAX_INPUT_CHARS,layers} from '../src/core.js';
import {createService,ANALYSIS_PROMPT} from '../src/service.js';
import {setup} from '../src/frontend.js';

// 2026-10-18 10:10 UTC = 19:10 Asia/Seoul; 2026-10-17 16:30 UTC = 2026-10-18 01:30 Asia/Seoul.
const evening=Date.UTC(2026,9,18,10,10)/1000,lateNight=Date.UTC(2026,9,17,16,30)/1000;

test('send time stamps use the given time zone, tolerate ms, and fall back to UTC explicitly',()=>{
 assert.equal(sentStamp({send_date:evening},'Asia/Seoul'),'2026-10-18 19:10');
 assert.equal(sentStamp({send_date:evening*1000},'Asia/Seoul'),'2026-10-18 19:10');
 assert.equal(sentStamp({send_date:lateNight},'Asia/Seoul'),'2026-10-18 01:30');
 assert.equal(sentStamp({send_date:lateNight},'UTC'),'2026-10-17 16:30');
 assert.equal(sentStamp({created_at:evening},'Asia/Seoul'),'2026-10-18 19:10');
 assert.equal(sentStamp({send_date:0},'Asia/Seoul'),null);assert.equal(sentStamp({content:'x'},'UTC'),null);
 assert.equal(validTimeZone('Not/AZone'),null);assert.equal(validTimeZone('Asia/Seoul;x'),null);assert.equal(validTimeZone(42),null);
 assert.equal(sourceInput([{content:'안녕',send_date:evening}],'Asia/Seoul'),'[메시지 전송 시각 기준: Asia/Seoul]\n\n[전송 2026-10-18 19:10] 안녕');
 assert.equal(sourceInput([{content:'안녕',send_date:evening}],'Not/AZone'),'[메시지 전송 시각 기준: UTC (사용자 시간대 미확인)]\n\n[전송 2026-10-18 10:10] 안녕');
 assert.equal(sourceInput([{content:'안녕'}],'Asia/Seoul'),'[메시지 전송 시각 기준: Asia/Seoul]\n\n[전송 시각 미상] 안녕');
 assert.equal(sourceInput([],'Asia/Seoul'),'');
});

test('analysis instruction carries the date rules and an exact schema example',()=>{
 assert.match(ANALYSIS_PROMPT,/기억 후보의 JSON 배열/);
 assert.match(ANALYSIS_PROMPT,/\[전송 YYYY-MM-DD HH:mm\]/);
 assert.match(ANALYSIS_PROMPT,/\[이야기 2일차 저녁\]/);assert.match(ANALYSIS_PROMPT,/\[1923-04-12 밤\]/);
 assert.match(ANALYSIS_PROMPT,/\[기록 2026-10-18 19:10\]/);
 assert.match(ANALYSIS_PROMPT,/어제, 오늘, 내일, 방금/);assert.match(ANALYSIS_PROMPT,/절대 날짜·시각/);
 assert.match(ANALYSIS_PROMPT,/원문과 같은 언어/);
 const example=JSON.parse(ANALYSIS_PROMPT.match(/예: (\[\{.*?\}\])/)[1]);
 assert.equal(example.length,1);assert.ok(layers.includes(example[0].layer));assert.equal(typeof example[0].text,'string');assert.equal(example[0].scope,'unknown');
 assert.deepEqual(normalizeCandidates(example).items,example);
});

const fake=(messages,content)=>{const db=new Map(),calls=[];const gen=kind=>async input=>{calls.push({kind,input});return {content:typeof content==='function'?content():content};};
 return {calls,api:{permissions:{has:()=>true},chats:{getActive:async()=>({id:'a'}),get:async(id,u)=>u==='owner'&&id==='a'?{id,metadata:{}}:null},userStorage:{exists:async k=>db.has(k),getJson:async k=>structuredClone(db.get(k)),setJson:async(k,v)=>{db.set(k,structuredClone(v));}},chat:{getMessages:async()=>structuredClone(messages)},connections:{get:async id=>({id,name:'n',provider:'p',model:'m'})},generate:{raw:gen('raw'),quiet:gen('quiet')}}};};
const chat=[{id:'m1',content:'어제 약속했잖아.',send_date:evening,extra:{}},{id:'m2',content:'내일 돌려줄게.',send_date:lateNight*1000,extra:{}}];

for(const mode of ['raw','quiet'])test(mode+' analysis input stamps each message with its send time; evidence stays on the original text',async()=>{
 const f=fake(chat,'[{"layer":"promises","text":"[기록 2026-10-18 19:10] 공책 반환 약속","scope":"unknown"}]'),s=createService(f.api);
 const r=await s.run({type:'analyze',chatId:'a',revision:0,mode,connection:'c1',source:{scope:'range',ranges:[{start:1,end:2}]},timeZone:'Asia/Seoul'},'owner');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,mode);
 assert.equal(f.calls[0].input.messages[0].content,ANALYSIS_PROMPT);assert.equal(f.calls[0].input.messages[1].content,'[메시지 전송 시각 기준: Asia/Seoul]\n\n[전송 2026-10-18 19:10] 어제 약속했잖아.\n\n[전송 2026-10-18 01:30] 내일 돌려줄게.');
 assert.equal(r.state.candidates.length,1);assert.equal(r.notice,'대화 1–2 (2개) 분석 · 후보 1개 추가 · 검토 대기에서 확인 후 승인하세요');
 assert.equal(r.total,2);assert.deepEqual(r.hidden,[]);
 assert.deepEqual(r.state.candidates[0].evidence.map(e=>e.fingerprint),[await fingerprint(chat[0].content),await fingerprint(chat[1].content)]);
});

test('input cap counts the time stamps, not only the raw message text',async()=>{
 const half='x'.repeat(29990),msgs=[{id:'m1',content:half,send_date:evening},{id:'m2',content:half,send_date:evening}];
 assert.ok(half.length*2+2<=MAX_INPUT_CHARS);assert.ok(sourceInput(msgs,'Asia/Seoul').length>MAX_INPUT_CHARS);
 const f=fake(msgs,'[]'),s=createService(f.api);
 // Stamps push the pair over the limit, so the two messages go in two calls.
 const out=await s.run({type:'analyze',chatId:'a',revision:0,mode:'raw',connection:'c1',source:{scope:'last',n:2},timeZone:'Asia/Seoul'},'owner');
 assert.equal(f.calls.length,2);assert.match(out.notice,/대화 1–2 → 1, 2으로 나눠 분석/);
 for(const c of f.calls)assert.ok(c.input.messages[1].content.length<=MAX_INPUT_CHARS);
});

test('model output variants are normalized',()=>{
 const one=[{layer:'promises',text:'A',scope:'unknown'}];
 for(const key of ['candidates','memories','items'])assert.deepEqual(normalizeCandidates(parseCandidates(JSON.stringify({[key]:one}))).items,one);
 assert.deepEqual(parseCandidates('```json\n{"memories":[{"layer":"wiki","text":"W"}]}\n```'),[{layer:'wiki',text:'W'}]);
 const korean={'약속':'promises','진행 흐름':'flows','진행흐름':'flows','기억 앵커':'anchors','장면 기억':'scenes','요소 기억':'elements','이야기 위키':'wiki'};
 for(const [name,id] of Object.entries(korean))assert.equal(normalizeCandidates([{layer:name,text:'t'}]).items[0].layer,id,name);
 for(const [name,id] of [['Promises','promises'],['PROMISE','promises'],['anchor','anchors'],[' Scene ','scenes'],['Element','elements'],['flow','flows'],['Wiki','wiki'],['wikis','wiki']])assert.equal(normalizeCandidates([{layer:name,text:'t'}]).items[0].layer,id,name);
 for(const scope of [undefined,null,'','secret',1,true])assert.equal(normalizeCandidates([{layer:'wiki',text:'t',scope}]).items[0].scope,'unknown');
 assert.equal(normalizeCandidates([{layer:'wiki',text:'t',scope:' PUBLIC '}]).items[0].scope,'public');
 for(const key of ['content','summary','memory'])assert.equal(normalizeCandidates([{layer:'wiki',[key]:' 본문 '}]).items[0].text,'본문');
 assert.equal(normalizeCandidates([{layer:'wiki',text:12}]).items[0].text,'12');assert.equal(normalizeCandidates([{layer:'wiki',text:false}]).items[0].text,'false');
 assert.deepEqual(normalizeCandidates([{layer:'  약속 ',text:'  공백  ',scope:'unknown',extra:'x',status:'weird'}]).items,[{layer:'promises',text:'공백',scope:'unknown'}]);
});

test('unusable items are skipped with a reason instead of failing the batch',()=>{
 const n=normalizeCandidates([{layer:'promises',text:'ok'},{text:'no layer'},{layer:'memo',text:'x'},{layer:'wiki'},{layer:'wiki',text:{a:1}},{layer:'wiki',text:'   '},{layer:'wiki',text:'y'.repeat(20001)},'string',null]);
 assert.equal(n.total,9);assert.equal(n.items.length,1);
 assert.deepEqual(n.skipped.map(x=>x.reason),['필드 layer 누락','필드 layer 값 memo 인식 불가','필드 text 누락','필드 text 형식 오류(문자열 아님)','필드 text 비어 있음','필드 text 20,000자 초과','객체가 아님','객체가 아님']);
 assert.deepEqual(parseCandidates('[{"layer":"wiki","text":"a"},"oops",3]'),[{layer:'wiki',text:'a'},'oops',3]);
});

test('dangerous keys and the size limit still reject the whole response',()=>{
 assert.throws(()=>parseCandidates('[{"layer":"wiki","text":"a","__proto__":{"x":1}}]'),/위험한 키/);
 assert.throws(()=>parseCandidates('{"candidates":[{"layer":"wiki","text":"a","constructor":1}]}'),/위험한 키/);
 assert.throws(()=>parseCandidates('[{"layer":"wiki","text":"'+'x'.repeat(2000001)+'"}]'),/크기 제한 2MB/);
});

test('partial format errors save the usable candidates and report the excluded count',async()=>{
 const f=fake(chat,'{"candidates":[{"layer":"약속","content":"공책","scope":"public"},{"layer":"memo","text":"x"},{"layer":"Scenes","summary":"장면"}]}'),s=createService(f.api);
 const r=await s.run({type:'analyze',chatId:'a',revision:0,mode:'raw',connection:'c1',source:{scope:'range',ranges:[{start:1,end:1}]}},'owner');
 assert.deepEqual(r.state.candidates.map(x=>[x.layer,x.text,x.scope]),[['promises','공책','unknown'],['scenes','장면','unknown']]);
 assert.equal(r.notice,'대화 1 (1개) 분석 · 후보 2개 추가 · 3개 중 1개 형식 오류로 제외(예: 2번째 항목 필드 layer 값 memo 인식 불가) · 검토 대기에서 확인 후 승인하세요');
});

test('when every item fails, the first reason and the response head are shown',async()=>{
 const raw='[{"kind":"promise","body":"공책"},{"layer":"memo","text":"x"}]'+' '.repeat(10)+'z'.repeat(200);
 const f=fake(chat,raw),s=createService(f.api);
 await assert.rejects(()=>s.run({type:'analyze',chatId:'a',revision:0,mode:'raw',connection:'c1',source:{scope:'last',n:1}},'owner'),e=>{
  assert.match(e.message,/후보 2개가 모두 형식 오류입니다\(첫 항목: 필드 layer 누락\)/);
  assert.ok(e.message.includes('응답 앞부분: '+raw.slice(0,120)+'…'));return true;});
 const empty=fake(chat,'[]'),s2=createService(empty.api);
 const ok=await s2.run({type:'analyze',chatId:'a',revision:0,mode:'raw',connection:'c1',source:{scope:'last',n:1}},'owner');assert.equal(ok.state.candidates.length,0);assert.match(ok.notice,/후보 0개 추가/);
});

test('the panel shows the exclusion notice instead of a bare save message',()=>{
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);const sent=[];let listener;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 const state={revision:0,items:[],candidates:[],undo:[]};
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state});
 const status=()=>root.querySelector('[role=status]').textContent;
 [...root.querySelectorAll('button')].find(x=>x.textContent==='분석').click();
 listener({requestId:sent.at(-1).requestId,ok:true,chatId:'a',state,saved:true,notice:'저장 완료 · 3개 중 1개 형식 오류로 제외(예: 2번째 항목 필드 layer 누락)'});
 assert.match(status(),/3개 중 1개 형식 오류로 제외/);
 [...root.querySelectorAll('button')].find(x=>x.textContent==='새로고침').click();
 listener({requestId:sent.at(-1).requestId,ok:true,chatId:'a',state:{...state,revision:1},saved:true});
 assert.equal(status(),'저장 완료');cleanup();
});
