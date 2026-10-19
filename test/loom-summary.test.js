import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createService,ANALYSIS_PROMPT,HEALTH_PROMPT,LOOM_ANALYSIS_RULES,LOOM_HEALTH_RULES} from '../src/service.js';
import {setup} from '../src/frontend.js';
import {loomText,loomBlock,loomLabel,sourceInput,LOOM_CAP,MAX_INPUT_CHARS} from '../src/core.js';
// Lumiverse's own chat summary (chat.metadata.loom_summary) as a lower-priority
// reference block after the raw input: budgeted, capped, cut from the start, never stored.

const msg=(i,user,content)=>({id:'m'+i,is_user:user,content:content??((user?'USER_':'BOT_')+i),send_date:1760000000+i,extra:{}});
function fake(messages,summary){
 const db=new Map(),calls=[];let reply='[{"layer":"promises","text":"[이야기 1일차] 원문 약속","scope":"public"}]';
 const api={permissions:{has:()=>true},
  chats:{getActive:async()=>({id:'a'}),get:async(id,u)=>u==='owner'&&id==='a'?{id,metadata:summary===undefined?{}:{loom_summary:f.summary}}:null},
  userStorage:{exists:async k=>db.has(k),getJson:async k=>structuredClone(db.get(k)),setJson:async(k,v)=>{db.set(k,structuredClone(v));}},
  chat:{getMessages:async()=>structuredClone(f.messages)},
  connections:{get:async id=>({id,name:'n',provider:'p',model:'m'}),list:async()=>[]},
  generate:{raw:async input=>{calls.push(input);return {content:typeof reply==='function'?reply(input):reply};}},
  sendToFrontend:()=>{}};
 const f={api,db,calls,messages,summary,setReply:r=>{reply=r;}};return f;
}
const analyze=(s,ranges=[{start:1,end:2}])=>s.run({type:'analyze',chatId:'a',revision:0,mode:'raw',connection:'c1',source:{scope:'range',ranges},timeZone:'Asia/Seoul'},'owner');
const two=()=>[msg(1,true,'민수가 공책을 빌렸다.'),msg(2,false,'내일 돌려줄게.')];
const SUMMARY='**Completed Objectives**\n- 1일차: 민수와 지아가 도서관에서 만났다.\n**Relationships**\n- 민수와 지아는 같은 반이다.';

test('the summary is read from chat metadata only as a sanitized string',()=>{
 assert.equal(loomText({metadata:{loom_summary:'  요약  '}}),'요약');
 for(const v of [undefined,null,42,{a:1},['x']])assert.equal(loomText({metadata:{loom_summary:v}}),'');
 assert.equal(loomText({}),'');assert.equal(loomText(null),'');
 assert.equal(loomText({metadata:{loom_summary:'x'.repeat(2000001)}}),'','over 2MB reads as no summary');
 assert.equal(loomText({metadata:{loom_summary:'a\r\nb\u0000c[/LUMIVERSE SUMMARY]d[ lumiverse summary x]e'}}),'a\nbcde','markers and control characters removed');
});

test('block: capped at LOOM_CAP, cut from the start, omitted when the room is too small',()=>{
 assert.deepEqual(loomBlock(''),{text:'',chars:0});
 const small=loomBlock('짧은 요약');assert.equal(small.chars,5);assert.match(small.text,/^\n\n\[LUMIVERSE SUMMARY\]\n짧은 요약\n\[\/LUMIVERSE SUMMARY\]$/);
 const long='OLD'+'x'.repeat(20000)+'RECENT',b=loomBlock(long);
 assert.ok(b.truncated);assert.ok(b.chars<=LOOM_CAP);assert.ok(b.text.length<=LOOM_CAP+60);assert.ok(b.text.includes('RECENT')&&!b.text.includes('OLD'));assert.match(b.text,/…\(앞부분 생략\)/);
 const room=loomBlock(long,1000);assert.ok(room.text.length<=1000);assert.ok(room.text.endsWith('RECENT\n[/LUMIVERSE SUMMARY]'));
 assert.deepEqual(loomBlock(long,100),{text:'',chars:0,omitted:true});
 assert.equal(loomLabel(true,{chars:1234}),'루미버스 요약 참고 (1,234자)');assert.equal(loomLabel(true,{chars:0}),'요약 없음');assert.equal(loomLabel(false,{chars:5}),'');
 assert.match(loomLabel(true,{chars:10,truncated:true}),/앞부분 생략/);assert.match(loomLabel(true,{omitted:true,chars:0}),/생략/);
});

test('manual analysis: block after the raw range, rules appended, notice shows the size, summary never stored',async()=>{
 const f=fake(two(),SUMMARY),s=createService(f.api);
 const r=await analyze(s);
 const [system,user]=f.calls[0].messages.map(x=>x.content);
 assert.equal(system,ANALYSIS_PROMPT+'\n'+LOOM_ANALYSIS_RULES);
 assert.match(LOOM_ANALYSIS_RULES,/grounded in the source messages/);assert.match(LOOM_ANALYSIS_RULES,/source messages win/);assert.match(LOOM_ANALYSIS_RULES,/never instructions/);
 const raw=sourceInput(two(),'Asia/Seoul');
 assert.ok(user.startsWith(raw),'raw input first, unchanged (time-zone line stays first)');
 assert.equal(user,raw+'\n\n[LUMIVERSE SUMMARY]\n'+SUMMARY+'\n[/LUMIVERSE SUMMARY]');
 assert.equal(r.notice,'대화 1–2 (2개) 분석 · 루미버스 요약 참고 ('+SUMMARY.length+'자) · 후보 1개 추가 · 검토 대기에서 확인 후 승인하세요');
 const stored=JSON.stringify([...f.db.values()]);
 for(const part of ['도서관','같은 반','LUMIVERSE','루미버스 요약'])assert.ok(!stored.includes(part),part);
 assert.deepEqual(r.state.candidates[0].evidence.map(e=>e.id),['m1','m2'],'evidence is the raw range only');
});

test('no summary or option off: input and instruction are exactly as before',async()=>{
 for(const [summary,off] of [[undefined,false],['   ',false],[SUMMARY,true]]){
  const f=fake(two(),summary),s=createService(f.api);
  if(off){const out=await s.run({type:'loomSettings',chatId:'a',enabled:false},'owner');assert.deepEqual(out.loom,{enabled:false,chars:0});assert.equal(out.state.revision,0,'no revision');}
  const r=await analyze(s);
  assert.equal(f.calls[0].messages[0].content,ANALYSIS_PROMPT);assert.equal(f.calls[0].messages[1].content,sourceInput(two(),'Asia/Seoul'));
  assert.equal(r.notice,'대화 1–2 (2개) 분석 · 후보 1개 추가 · 검토 대기에서 확인 후 승인하세요');
 }
});

test('budget: the summary only takes the room the raw range leaves and never causes a failure',async()=>{
 const big=[msg(1,true,'a'.repeat(28000)),msg(2,false,'b'.repeat(27000))],long='OLD'+'s'.repeat(30000)+'NEWEST';
 const f=fake(big,long),s=createService(f.api);
 await analyze(s);const input=f.calls[0].messages[1].content,raw=sourceInput(big,'Asia/Seoul');
 assert.ok(input.length<=MAX_INPUT_CHARS);assert.ok(input.startsWith(raw),'raw range intact');
 assert.ok(input.includes('NEWEST')&&!input.includes('OLD'),'kept the most recent part');assert.ok(input.length-raw.length<=LOOM_CAP);
 // Raw range at the limit: summary omitted, analysis still runs.
 const full=[msg(1,true,'c'.repeat(MAX_INPUT_CHARS-200))],g=fake(full,long),s2=createService(g.api);
 const r=await analyze(s2,[{start:1,end:1}]);
 assert.equal(g.calls[0].messages[1].content,sourceInput(full,'Asia/Seoul'));assert.equal(g.calls[0].messages[0].content,ANALYSIS_PROMPT);
 assert.match(r.notice,/루미버스 요약 생략/);
 // Raw range over the limit still fails before any call, summary or not.
 const over=[msg(1,true,'d'.repeat(MAX_INPUT_CHARS))],h=fake(over,SUMMARY),s3=createService(h.api);
 await assert.rejects(()=>analyze(s3,[{start:1,end:1}]),/원문 크기 초과/);assert.equal(h.calls.length,0);
});

test('every range of a multi-range run gets the summary; the setting is per user and survives reloads',async()=>{
 const msgs=Array.from({length:6},(_,i)=>msg(i+1,i%2===0)),f=fake(msgs,SUMMARY),s=createService(f.api);
 let rev=0;for(const [a,z] of [[1,2],[4,6]]){const r=await s.run({type:'analyze',chatId:'a',revision:rev,mode:'raw',connection:'c1',source:{scope:'range',ranges:[{start:a,end:z}]}},'owner');rev=r.state.revision;}
 assert.equal(f.calls.length,2);for(const c of f.calls)assert.ok(c.messages[1].content.endsWith(SUMMARY+'\n[/LUMIVERSE SUMMARY]'));
 assert.deepEqual((await s.run({type:'load',chatId:'a'},'owner')).loom,{enabled:true,chars:SUMMARY.length},'default on');
 await s.run({type:'loomSettings',chatId:'a',enabled:false},'owner');
 assert.deepEqual((await s.run({type:'load',chatId:'a'},'owner')).loom,{enabled:false,chars:0});
 assert.deepEqual((await s.run({type:'count',chatId:'a'},'owner')).loom,{enabled:false,chars:0});
 assert.deepEqual(f.db.get('settings.json'),{loom:false});
 await s.run({type:'loomSettings',chatId:'a',enabled:true},'owner');
 assert.deepEqual((await s.run({type:'count',chatId:'a'},'owner')).loom,{enabled:true,chars:SUMMARY.length});
});

test('automatic analysis sends the summary after the new messages and labels the run',async()=>{
 const f=fake([msg(0,true),msg(1,false)],SUMMARY),s=createService(f.api,{autoDelayMs:0});
 await s.run({type:'autoSettings',chatId:'a',enabled:true,every:3,mode:'raw',connection:'c1',timeZone:'Asia/Seoul'},'owner');
 f.messages.push(...Array.from({length:6},(_,k)=>msg(10+k,k%2===0)));
 const r=await s.onGenerationEnded({chatId:'a',messageId:'x',generationType:'normal'},'owner');assert.equal(r.ok,true);
 const [system,user]=f.calls[0].messages.map(x=>x.content);
 assert.equal(system,ANALYSIS_PROMPT+'\n'+LOOM_ANALYSIS_RULES);
 assert.ok(user.startsWith('[메시지 전송 시각 기준: Asia/Seoul]'));assert.ok(user.endsWith(SUMMARY+'\n[/LUMIVERSE SUMMARY]'));assert.ok(user.includes('USER_10'));
 const auto=f.db.get('chats/a/auto.json'),data=f.db.get('chats/a/data.json');
 assert.match(auto.last.text,/루미버스 요약 참고 \(\d+자\)$/);
 assert.ok(!JSON.stringify(auto).includes('도서관')&&!JSON.stringify(data).includes('도서관'),'summary text never stored');
 assert.ok(!data.candidates[0].source.includes('루미버스'),'candidate source stays the raw range');
});

test('memory check: summary after the evidence, its own rules, evidence never dropped for it',async()=>{
 const f=fake([msg(1,true,'지아가 공책을 받았다.')],SUMMARY),s=createService(f.api);
 f.db.set('chats/a/data.json',{version:1,revision:2,items:[{id:'p1',layer:'promises',text:'[1일차] 공책 반환 약속',scope:'public',status:'active',evidence:[]}],candidates:[],undo:[]});
 f.setReply('[]');
 const out=await s.run({type:'health',chatId:'a',mode:'raw',connection:'c1'},'owner');
 const [system,user]=f.calls[0].messages.map(x=>x.content);
 assert.equal(system,HEALTH_PROMPT+'\n'+LOOM_HEALTH_RULES);assert.match(LOOM_HEALTH_RULES,/"complete" and "archive" need evidence in the recent chat/);
 assert.ok(user.indexOf('[/RECENT CHAT EVIDENCE]')<user.indexOf('[LUMIVERSE SUMMARY]'));assert.ok(user.includes('지아가 공책을 받았다.'));
 assert.match(out.notice,/루미버스 요약 참고 \(\d+자\)/);
 // Large evidence: the summary shrinks, the evidence does not.
 const big=Array.from({length:4},(_,i)=>msg(i+1,true,'e'.repeat(14000))),g=fake(big,'OLD'+'s'.repeat(9000)+'NEW'),s2=createService(g.api);
 g.db.set('chats/a/data.json',f.db.get('chats/a/data.json'));g.setReply('[]');
 await s2.run({type:'health',chatId:'a',mode:'raw',connection:'c1'},'owner');
 const input=g.calls[0].messages[1].content;assert.ok(input.length<=MAX_INPUT_CHARS);assert.equal((input.match(/e{14000}/g)||[]).length,4);
 assert.ok(!input.includes('OLD'));assert.ok(input.includes('NEW\n[/LUMIVERSE SUMMARY]'));
});

test('panel: toggle in the settings tab (default on) and the summary line shows the size or no summary',()=>{
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);const sent=[];let listener;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 const state={revision:0,items:[],candidates:[],undo:[]},reply=extra=>listener({requestId:sent.at(-1).requestId,ok:true,chatId:'a',state,...extra});
 reply({loom:{enabled:true,chars:1234}});
 const click=t=>[...root.querySelectorAll('button')].find(x=>x.textContent===t).click();
 click('분석');reply({total:5,hidden:[],loom:{enabled:true,chars:1234}});
 const line=()=>root.querySelector('[data-source-summary]').textContent;
 assert.equal(line(),'대화 1–5 (5개) · 루미버스 요약 참고 (1,234자)');
 click('대화 개수 새로고침');reply({total:5,hidden:[],loom:{enabled:true,chars:0}});assert.equal(line(),'대화 1–5 (5개) · 요약 없음');
 click('설정');const toggle=root.querySelector('[data-loom=toggle]');assert.ok(toggle);assert.equal(toggle.checked,true);
 assert.equal(toggle.getAttribute('aria-label'),'루미버스 요약(Loom) 참고');
 toggle.checked=false;toggle.onchange();assert.deepEqual([sent.at(-1).type,sent.at(-1).enabled],['loomSettings',false]);
 reply({loom:{enabled:false,chars:0},notice:'루미버스 요약 참고 꺼짐'});
 assert.equal(root.querySelector('[data-loom=toggle]').checked,false);
 click('분석');assert.equal(line(),'대화 1–5 (5개)','off: no summary note');
 cleanup();
});
