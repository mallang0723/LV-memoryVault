// Optional QA (Bun): entries written by the scene chronicle service go through
// Lumiverse's own world-info activation and bucketing code (read-only source tree,
// LUMIVERSE_SRC, default ../Lumiverse/src next to this repo's parent). The prompt is
// assembled the way prompt-assembly puts "world_info_before" entries (content only)
// and sent to a local fake provider over HTTP; the captured request is checked.
// Not a full host run: presets, macros and the real generation route are not used.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createService} from '../src/service.js';
import {sceneFake,makeMessages,rec,approveLast,as} from '../test/scene-fake.js';
const src=resolve(process.env.LUMIVERSE_SRC||'../../Lumiverse/src');
const wi=await import(src+'/services/world-info-activation.service.ts');
const out='context/receipts';mkdirSync(out,{recursive:true});
const checks=[];const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,...(detail!==undefined?{detail}:{})});};
// Chat: 60 turns. Scene 1–10 is about the lighthouse (등대), 11–20 about the well (우물).
const msgs=makeMessages(60);
msgs[57].content='민수가 등대에서 지아를 기다렸다.';// within the last 6 messages
msgs[49].content='우물 이야기는 여기서만 나온다.';// 11 messages back: outside scan depth 6
const f=sceneFake({messages:msgs}),s=createService(f.api,{autoDelayMs:1});
const bodies=['[이야기 1일차 밤] 민수가 등대지기에게서 낡은 열쇠를 받았다.','[이야기 2일차 아침] 지아가 마을 우물 바닥에서 편지를 찾았다.','[이야기 2일차 저녁] 민수와 지아가 시장에서 다퉜다.','[이야기 3일차] 두 사람이 화해하고 배를 빌렸다.','[이야기 3일차 밤] 배가 폭풍에 밀려 섬에 닿았다.'];
const keys=[['등대','열쇠'],['우물','편지'],['시장'],['배'],['섬','폭풍']];
let n=0;f.setReply(()=>JSON.stringify({title:'제목'+n,body:bodies[n],keywords:keys[n++],promises:[],flows:[]}));
for(const [a,b] of [[1,10],[11,20],[21,30],[31,40],[41,50]]){await rec(s,a,b);await approveLast(s);}
const v=(await as(s,{type:'sceneLoad'})).chronicle;
const now=Math.floor(Date.now()/1000);
const entries=[...f.entries.values()].map((e,i)=>({folder:'',tags:[],uid:e.id,outlet_name:null,wi_marker:null,wi_marker_side:null,role:null,group_name:'',group_override:false,group_weight:100,exclude_greeting:false,automation_id:null,delay_until_recursion:false,priority:0,sticky:0,cooldown:0,delay:0,selective_logic:0,vectorized:false,vector_index_status:'not_enabled',vector_index_error:null,vector_indexed_at:null,revision:1,created_at:now,updated_at:now,depth:4,probability:100,use_probability:false,...e}));
const hostMessages=f.msgs.a.map((m,i)=>({id:m.id,chat_id:'a',index_in_chat:i,is_user:m.is_user,name:m.is_user?'User':'Char',content:m.content,send_date:m.send_date,swipe_id:0,swipes:[m.content],swipe_dates:[m.send_date],extra:{},parent_message_id:null,branch_id:null,created_at:m.send_date}));
const result=wi.activateWorldInfo({entries,messages:hostMessages,chatTurn:hostMessages.length,wiState:{},settings:{},random:()=>0});
const label=e=>e.comment;
const activated=result.activatedEntries.map(label).sort();
check('constant: newest three scenes always active',['장면 21–30','장면 31–40','장면 41–50'].every(l=>activated.includes(l)),activated);
check('keyword: 장면 1–10 activated by "등대에서" in the last 6 messages (match_whole_words false)',activated.includes('장면 1–10'));
check('scan depth 6: 장면 11–20 not activated by a keyword 11 messages back',!activated.includes('장면 11–20'));
const quiet=hostMessages.map((m,i)=>i===57?{...m,content:'평범한 대화',swipes:['평범한 대화']}:m);
const without=wi.activateWorldInfo({entries,messages:quiet,chatTurn:quiet.length,wiState:{},settings:{},random:()=>0}).activatedEntries.map(label);
check('negative control: without the recent mention 장면 1–10 stays off',!without.includes('장면 1–10'),without.sort());
// prompt-assembly.service.ts ("world_info_before"): one message per entry, content only.
const before=result.cache.before.map(x=>({role:'system',content:x.content}));
const history=hostMessages.filter(m=>!m.extra.hidden).map(m=>({role:m.is_user?'user':'assistant',content:m.content}));
const captured=[];
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async req=>{captured.push(await req.json());return Response.json({id:'fake',choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}]});}});
await fetch('http://127.0.0.1:'+server.port+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fake',messages:[{role:'system',content:'캐릭터 설명'},...before,...history]})});
server.stop(true);
const wire=JSON.stringify(captured);
for(const bad of [...v.nodes.map(x=>x.label),...v.nodes.map(x=>x.title),'기억 보관함','장면록',f.names.a,'memory_cabinet','Chapter','Summary','요약:'])check('capture has no '+JSON.stringify(bad),!wire.includes(bad));
check('capture carries the activated bodies',before.length===4&&before.every(b=>wire.includes(JSON.stringify(b.content).slice(1,-1))),before.map(b=>b.content.slice(0,20)));
check('every injected body starts with a [date]',before.every(b=>/^\[[^\]]+\]/.test(b.content)));
writeFileSync(out+'/host-wi-qa.json',JSON.stringify({kind:'Lumiverse world-info activation code + local fake provider HTTP capture (not a full host run)',lumiverseSrc:src,activated,capturedRequest:captured[0],checks},null,2));
const failed=checks.filter(c=>!c.ok);
console.log(JSON.stringify({checks:checks.length,failed:failed.map(c=>c.name)}));
process.exitCode=failed.length?1:0;
