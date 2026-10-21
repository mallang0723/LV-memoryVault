import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {splitForInput,splitNote,chunkSpan,sourceInput,batchSummary,MAX_INPUT_CHARS} from '../src/core.js';
import {createService} from '../src/service.js';
import {setup} from '../src/frontend.js';
import {sceneFake,makeMessages,rec,as,SCENE_REPLY} from './scene-fake.js';
const item=(i,n)=>({m:{id:'m'+(i+1),content:'가'.repeat(n),send_date:1760000000+i},index:i});
// ---- splitting -------------------------------------------------------------------
test('split: consecutive chunks at message boundaries, each fitting the limit, nothing lost or reordered',()=>{
 const items=Array.from({length:30},(_,i)=>item(i,4000+i*37));
 const {chunks,skipped}=splitForInput(items,'Asia/Seoul');
 assert.deepEqual(skipped,[]);assert.deepEqual(chunks.flat().map(x=>x.index),items.map(x=>x.index));
 for(const c of chunks){assert.ok(sourceInput(c.map(x=>x.m),'Asia/Seoul').length<=MAX_INPUT_CHARS);}
 // Greedy: no chunk could have taken the next message.
 for(let k=0;k+1<chunks.length;k++)assert.ok(sourceInput([...chunks[k],chunks[k+1][0]].map(x=>x.m),'Asia/Seoul').length>MAX_INPUT_CHARS);
 const fits=splitForInput(items.slice(0,3),'Asia/Seoul');assert.equal(fits.chunks.length,1);assert.equal(splitNote('대화 1–3',fits),'');
});
test('split: exact boundary counts the header, stamps and separators; one message over the limit is skipped, never cut',()=>{
 const one=[item(0,1)],room=MAX_INPUT_CHARS-sourceInput(one.map(x=>x.m),'Asia/Seoul').length;
 const exact=[item(0,1+room)];assert.equal(sourceInput(exact.map(x=>x.m),'Asia/Seoul').length,MAX_INPUT_CHARS);
 assert.equal(splitForInput(exact,'Asia/Seoul').chunks.length,1,'exactly at the limit fits');
 const over=[item(0,2+room)];const r=splitForInput(over,'Asia/Seoul');assert.equal(r.chunks.length,0);assert.deepEqual(r.skipped.map(x=>x.index),[0]);
 const mixed=splitForInput([item(0,10),item(1,MAX_INPUT_CHARS),item(2,10)],'Asia/Seoul');
 assert.deepEqual(mixed.chunks.map(chunkSpan),[[1,1],[3,3]]);assert.deepEqual(mixed.skipped.map(x=>x.index),[1]);
 assert.equal(splitNote('대화 1–3',mixed),'대화 1–3 → 1, 3으로 나눠 분석 · 메시지 2은 하나만으로 60,000자 한도를 넘어 건너뜀(잘라 보내지 않음)');
});
test('batch summary: one short line, details per range',()=>{
 const size='원문 크기 초과: 대화 1–30 입력 72,961자';
 const all=batchSummary({total:8,ok:0,fails:Array.from({length:8},(_,i)=>({label:'범위 '+(i+1),error:size}))});
 assert.equal(all.summary,'8개 범위 모두 실패 — 원문 크기 초과');assert.equal(all.detail.split('\n').length,8);
 assert.equal(batchSummary({total:2,ok:2,added:4}).summary,'2개 범위 분석 완료 (후보 4개 추가) · 검토 대기에서 확인 후 승인하세요');
});
// ---- scene recording split -------------------------------------------------------
test('scene range over the limit becomes several consecutive scenes, one call each, with a note',async()=>{
 const msgs=makeMessages(30).map(m=>({...m,content:m.content+' '+'나'.repeat(8000)}));msgs[20].content='다'.repeat(MAX_INPUT_CHARS+1);
 const f=sceneFake({messages:msgs}),s=createService(f.api,{autoDelayMs:1});
 const out=await rec(s,1,30);
 const c=out.chronicle.candidates;assert.ok(c.length>=4);assert.equal(f.calls.generate.length,c.length);
 for(const call of f.calls.generate){assert.ok(!call.messages[1].content.includes('다다다'),'oversized message never sent');}
 assert.equal(c[0].start,1);assert.equal(c.at(-1).end,30);
 for(let i=1;i<c.length;i++)assert.equal(c[i].start,c[i-1].end+(c[i-1].end===20?2:1),'consecutive; only message 21 is left out');
 assert.ok(c.every(x=>x.start>21||x.end<21),'no scene covers the oversized message');
 assert.match(out.notice,/대화 1–30 → .*으로 나눠 기록/);assert.match(out.notice,/메시지 21은 하나만으로/);assert.match(out.notice,/장면 후보 \d+개/);
 // The chunk after the first gets the scene just written as its reference.
 assert.ok(f.calls.generate[1].messages[1].content.startsWith('〈이전 기록〉\n'+SCENE_REPLY.body));
 // Promise candidates keep the evidence of their own chunk.
 const promises=out.state.candidates.filter(x=>x.layer==='promises');assert.equal(promises.length,c.length);
 promises.forEach((x,i)=>{assert.deepEqual([x.evidence[0].index+1,x.evidence.at(-1).index+1],[c[i].start,c[i].end]);});
});
test('re-recording one scene whose range no longer fits is refused before any call',async()=>{
 const f=sceneFake({messages:makeMessages(10)}),s=createService(f.api,{autoDelayMs:1});
 await rec(s,1,10);let v=(await as(s,{type:'sceneLoad'})).chronicle;
 await as(s,{type:'sceneApprove',id:v.candidates[0].id,scope:'unknown',sceneRevision:v.revision});
 for(const m of f.msgs.a)m.content+='라'.repeat(9000);
 const calls=f.calls.generate.length;
 await assert.rejects(()=>rec(s,1,10),/장면 하나로 다시 기록할 수 없습니다/);assert.equal(f.calls.generate.length,calls);
});
// ---- status notice ---------------------------------------------------------------
function mount(){
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);const sent=[];let listener;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state:{version:1,revision:0,items:[],candidates:[],undo:[]}});
 return {root,sent,listener,cleanup};
}
test('status notice: one line, details on demand, closes with ×, folds on outside tap, Escape closes',()=>{
 const {root,sent,listener,cleanup}=mount();
 const long='원문 크기 초과: '+'아주 긴 오류 설명 '.repeat(30);
 [...root.querySelectorAll('button')].find(b=>b.textContent==='새로고침').click();
 listener({requestId:sent.at(-1).requestId,ok:false,error:long});
 const bar=()=>root.querySelector('.lv-status');
 assert.equal(bar().hidden,false);assert.equal(root.querySelector('[role=status]').textContent,long);
 assert.equal(root.querySelector('[data-status-detail]'),null,'details folded by default');
 root.querySelector('[data-status-more]').click();assert.equal(root.querySelector('[data-status-detail]').textContent,long);
 // A tap elsewhere in the panel folds the details.
 root.querySelector('.mmc-tabs').dispatchEvent(new globalThis.document.defaultView.Event('click',{bubbles:true}));
 assert.equal(root.querySelector('[data-status-detail]'),null);
 root.querySelector('[data-status-close]').click();assert.equal(bar().hidden,true);
 // Escape on a new notice closes it.
 [...root.querySelectorAll('button')].find(b=>b.textContent==='새로고침').click();listener({requestId:sent.at(-1).requestId,ok:false,error:'짧은 오류'});
 assert.equal(root.querySelector('[data-status-more]'),null,'a short notice has no details button');
 const esc=new globalThis.document.defaultView.Event('keydown',{bubbles:true});esc.key='Escape';root.dispatchEvent(esc);assert.equal(bar().hidden,true);
 cleanup();
});
