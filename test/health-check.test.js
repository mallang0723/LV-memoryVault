import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createService,HEALTH_PROMPT} from '../src/service.js';
import {normalizeProposals,healthPlan,healthBase,MAX_INPUT_CHARS,MAX_PROPOSALS} from '../src/core.js';
import {setup} from '../src/frontend.js';
import {fake} from './backend.test.js';
// 기억 점검: model proposals (update / complete / archive only) for known memories,
// applied only when checked and only while the memory is unchanged since the check.
const mem=(id,layer,text,extra={})=>({id,layer,text,scope:'public',status:'active',evidence:[],...extra});
async function seeded(response,{messages}={}){
 const f=fake(),s=createService(f.a);let captured,calls=0;
 if(messages)f.a.chat.getMessages=async()=>messages;
 f.a.generate.raw=async input=>{calls++;captured=input;return {content:typeof response==='function'?response(input):response};};
 const items=[mem('p1','promises','[1일차] 민수가 공책을 돌려주기로 했다'),mem('a1','anchors','[1일차] 지아는 비를 싫어한다'),mem('a2','anchors','[1일차] 지아는 비 오는 날을 싫어한다'),mem('sec','anchors','NEVER_SEND_SECRET',{scope:'secret'}),mem('held','anchors','NEVER_SEND_HELD',{hold:true}),mem('known','anchors','NEVER_SEND_KNOWN',{knownBy:['x']})];
 f.db.set('chats/a/data.json',{version:1,revision:3,items,candidates:[],undo:[]});
 return {f,s,captured:()=>captured,calls:()=>calls};
}
const proposals=JSON.stringify([
 {action:'complete',target:'M1',reason:'돌려줌'},
 {action:'update',target:'m2',text:'[1일차] 지아는 비 오는 날을 싫어한다',reason:'M3와 중복이라 합침'},
 {action:'archive',target:'M3',reason:'M2에 합쳐짐'},
 {action:'keep',target:'M2'},
 {action:'archive',target:'M99',reason:'없는 대상'},
 {action:'archive',target:'sec',reason:'실제 ID 추측'},
 {action:'add',text:'새 사실'},
 {action:'delete',target:'M3'},
 {action:'complete',target:'M2',reason:'앵커는 완료 불가'}
]);

test('check sends only eligible memories under aliases plus recent chat, stores proposals without a revision',async()=>{
 const {s,captured,f}=await seeded(proposals);
 const out=await s.run({type:'health',chatId:'a',mode:'raw',connection:'fake'},'owner');
 const input=JSON.stringify(captured());
 for(const secret of ['NEVER_SEND_SECRET','NEVER_SEND_HELD','NEVER_SEND_KNOWN','"p1"','"a1"'])assert.ok(!input.includes(secret),secret);
 assert.match(input,/M1/);assert.match(input,/최근 대화 근거/);assert.match(input,/전송 시각 미상] public/,'recent message is evidence');assert.ok(input.includes('] secret'),'hidden message is evidence too (0.3.4)');
 assert.equal(captured().messages[0].content,HEALTH_PROMPT);assert.equal(captured().model,'fixture-model');
 assert.equal(out.state.revision,3,'a check never changes memories');
 assert.deepEqual(out.health.proposals.map(p=>[p.action,p.targetId]),[['complete','p1'],['update','a1'],['archive','a2']]);
 assert.match(out.notice,/제안 3개/);assert.match(out.health.note,/9개 중 5개 제외/);
 assert.ok(f.db.has('chats/a/health.json'));
 const loaded=await s.run({type:'load',chatId:'a'},'owner');assert.equal(loaded.health.proposals.length,3,'proposals survive a reload');
});

test('apply only checked proposals: complete, rewrite, archive as hold; nothing is deleted; undo works',async()=>{
 const {s}=await seeded(proposals);
 const {health}=await s.run({type:'health',chatId:'a',mode:'raw',connection:'fake'},'owner');
 const [complete,update,archive]=health.proposals;
 const out=await s.run({type:'healthApply',chatId:'a',revision:3,ids:[complete.id,archive.id]},'owner');
 const by=id=>out.state.items.find(x=>x.id===id);
 assert.equal(out.state.items.length,6);assert.equal(by('p1').status,'completed');assert.equal(by('a2').hold,true);assert.equal(by('a1').text,'[1일차] 지아는 비를 싫어한다','unchecked proposal not applied');
 assert.equal(out.state.revision,4);assert.deepEqual(out.health.proposals.map(p=>p.id),[update.id],'unchecked proposal stays');
 const second=await s.run({type:'healthApply',chatId:'a',revision:4,ids:[update.id]},'owner');
 assert.equal(second.state.items.find(x=>x.id==='a1').text,'[1일차] 지아는 비 오는 날을 싫어한다');assert.equal(second.health,null);
 const undone=await s.run({type:'undo',chatId:'a',revision:5},'owner');assert.equal(undone.state.items.find(x=>x.id==='a1').text,'[1일차] 지아는 비를 싫어한다');
});

test('a memory edited after the check is a conflict and is skipped, keeping the user edit',async()=>{
 const {s}=await seeded(proposals);
 const {health}=await s.run({type:'health',chatId:'a',mode:'raw',connection:'fake'},'owner');
 const loaded=await s.run({type:'load',chatId:'a'},'owner');const a1=loaded.state.items.find(x=>x.id==='a1');
 await s.run({type:'put',chatId:'a',revision:3,item:{...a1,text:'[1일차] 사용자가 고친 문장'}},'owner');
 const out=await s.run({type:'healthApply',chatId:'a',revision:4,ids:health.proposals.map(p=>p.id)},'owner');
 assert.equal(out.state.items.find(x=>x.id==='a1').text,'[1일차] 사용자가 고친 문장');
 assert.equal(out.state.items.find(x=>x.id==='p1').status,'completed');
 assert.match(out.notice,/2개 반영 · 충돌 1개/);
 assert.deepEqual(out.health.proposals.map(p=>[p.targetId,p.conflict]),[['a1',true]]);
 await assert.rejects(()=>s.run({type:'healthApply',chatId:'a',revision:5,ids:[out.health.proposals[0].id]},'owner'),/적용할 점검 제안/);
 const all=await s.run({type:'load',chatId:'a'},'owner');const deleted=await s.run({type:'healthDismiss',chatId:'a'},'owner');assert.equal(deleted.health,null);assert.equal(deleted.state.revision,all.state.revision);
 assert.equal((await s.run({type:'load',chatId:'a'},'owner')).health,null);
});

test('internal change command cannot be sent by the panel; dangerous keys and oversize responses are rejected',async()=>{
 const {s}=await seeded('[{"action":"archive","target":"M1","__proto__":{"x":1}}]');
 await assert.rejects(()=>s.run({type:'healthChanges',chatId:'a',revision:3,changes:[{targetId:'p1',action:'archive'}]},'owner'),/알 수 없는 작업/);
 await assert.rejects(()=>s.run({type:'health',chatId:'a',mode:'raw',connection:'fake'},'owner'),/위험한 키/);
 const big=await seeded('['+'"x",'.repeat(700000)+'"x"]');await assert.rejects(()=>big.s.run({type:'health',chatId:'a',mode:'raw',connection:'fake'},'owner'),/2MB/);
 await assert.rejects(()=>s.run({type:'health',chatId:'a',mode:'raw',connection:'bad/id'},'owner'),/모델 연결/);
 await assert.rejects(()=>s.run({type:'healthApply',chatId:'a',revision:3,ids:['nope']},'owner'),/점검 결과가 없습니다/);
});

test('input stays within the limit: oldest evidence dropped first; too many memories never call the model',async()=>{
 const messages=Array.from({length:60},(_,i)=>({id:'m'+i,content:'원문'+i+' '+'가'.repeat(3000),extra:{},send_date:1760000000+i}));
 const {s,captured}=await seeded('[]',{messages});
 const out=await s.run({type:'health',chatId:'a',mode:'raw',connection:'fake'},'owner');
 const input=captured().messages[1].content;assert.ok(input.length<=MAX_INPUT_CHARS,String(input.length));
 assert.match(input,/원문59 /);assert.ok(!input.includes('원문0 '));assert.equal(out.health,null);assert.match(out.notice,/고칠 것이 없습니다/);
 const many=await seeded('[]');many.f.db.set('chats/a/data.json',{version:1,revision:0,items:Array.from({length:4},(_,i)=>mem('x'+i,'wiki','가'.repeat(19000))),candidates:[],undo:[]});
 await assert.rejects(()=>many.s.run({type:'health',chatId:'a',mode:'raw',connection:'fake'},'owner'),/점검할 기억이 너무 많습니다/);assert.equal(many.calls(),0);
 const none=await seeded('[]');none.f.db.set('chats/a/data.json',{version:1,revision:0,items:[mem('s','anchors','x',{scope:'secret'})],candidates:[],undo:[]});
 await assert.rejects(()=>none.s.run({type:'health',chatId:'a',mode:'raw',connection:'fake'},'owner'),/점검할 기억이 없습니다/);
});

test('proposal normalization: aliases only, one per target, size and count limits',()=>{
 const t=new Map([['M1',mem('p','promises','a')],['M2',mem('w','wiki','b')]]);
 const n=normalizeProposals([{action:'UPDATE',targetId:'M2',content:'new'},{action:'archive',target:'M2'},{action:'complete',target:'M1'},{action:'update',target:'M1',text:'x'.repeat(20001)},'bad',{action:'rename',target:'M1'}],t);
 assert.deepEqual(n.items.map(x=>[x.action,x.targetId]),[['update','w'],['complete','p']]);assert.equal(n.skipped.length,4);
 const many=normalizeProposals(Array.from({length:40},(_,i)=>({action:'archive',target:'M'+(i+1)})),new Map(Array.from({length:40},(_,i)=>['M'+(i+1),mem('i'+i,'anchors','t')])));
 assert.equal(many.items.length,MAX_PROPOSALS);
 const state={items:[mem('p','promises','a')]},base=healthBase(state.items[0]);
 assert.equal(healthPlan(state,[{targetId:'p',action:'complete',base}]).changes.length,1);
 assert.equal(healthPlan({items:[{...state.items[0],hold:true}]},[{targetId:'p',action:'complete',base}]).conflicts.length,1);
 assert.equal(healthPlan({items:[]},[{targetId:'p',action:'complete',base}]).conflicts.length,1);
});

test('panel: check button uses the settings connection; proposals are a checklist with conflicts locked',async()=>{
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);const sent=[],asked=[];let listener;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}}),showConfirm:async o=>{asked.push(o);return {confirmed:true};}},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 const items=[mem('p1','promises','[1일차] 약속'),mem('a1','anchors','[1일차] 지금 문장')];
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state:{revision:0,items,candidates:[],undo:[]}});
 const run=()=>root.querySelector('[data-run="health"]');
 run().click();assert.match(root.querySelector('[role=status]').textContent,/모델 연결을 먼저/);
 assert.equal(sent.at(-1).type,'connections');
 listener({requestId:sent.at(-1).requestId,ok:true,chatId:'a',state:{revision:0,items,candidates:[],undo:[]},connections:[{id:'conn',name:'c',model:'m'}],auto:{enabled:true,every:10,mode:'raw',connection:'conn'}});
 [...root.querySelectorAll('button')].find(x=>x.textContent==='개요').click();
 run().click();const req=sent.at(-1);assert.deepEqual([req.type,req.mode,req.connection],['health','raw','conn']);assert.equal(run().disabled,true);
 const health={at:1,text:'기억 2개',note:'',proposals:[{id:'h1',action:'complete',targetId:'p1',layer:'promises',reason:'지킴',base:{text:'[1일차] 약속',status:'active',hold:false,scope:'public'}},{id:'h2',action:'update',targetId:'a1',layer:'anchors',text:'[1일차] 새 문장',reason:'압축',base:{text:'[1일차] 예전 문장',status:'active',hold:false,scope:'public'}}]};
 listener({requestId:req.requestId,ok:true,chatId:'a',state:{revision:0,items,candidates:[],undo:[]},health});
 const box=root.querySelector('[data-health]');assert.ok(box);assert.match(box.textContent,/점검 제안 2개/);
 const h1=root.querySelector('[data-proposal="h1"] input'),h2=root.querySelector('[data-proposal="h2"] input');
 assert.equal(h1.checked,true);assert.equal(h2.disabled,true,'changed since the check');assert.match(root.querySelector('[data-proposal="h2"]').textContent,/충돌/);
 root.querySelector('[data-health-apply]').click();assert.deepEqual([sent.at(-1).type,sent.at(-1).ids],['healthApply',['h1']]);
 root.querySelector('[data-health-dismiss]').click();await new Promise(r=>setTimeout(r,0));
 assert.match(asked[0].message,/제안 1개를 버립니다/);assert.equal(sent.at(-1).type,'healthDismiss');
 cleanup();
});
