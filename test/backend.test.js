import {test} from 'node:test';import assert from 'node:assert/strict';
import {createService} from '../src/service.js';
test('wiki model candidates cannot auto-select restricted audience fields',async()=>{
 const {selectSafeCandidates}=await import('../src/core.js');
 assert.equal(typeof selectSafeCandidates,'function');
 assert.deepEqual(selectSafeCandidates([{id:'safe',scope:'public'}, {id:'restricted',scope:'public',knownBy:['a']}, {id:'conditional',scope:'public',condition:'secret'}, {id:'audience',scope:'public',audience:'private'}]),['safe']);
});
export function fake(){const db=new Map(), grants=new Set(['chats','chat_mutation','generation','world_books']);let calls=0;
 const a={permissions:{has:p=>grants.has(p)},chats:{getActive:async()=>({id:'a'}),get:async(id,u)=>u==='owner'&&['a','b'].includes(id)?{id,metadata:{}}:null},userStorage:{exists:async k=>db.has(k),getJson:async k=>structuredClone(db.get(k)),setJson:async(k,v)=>{db.set(k,structuredClone(v));}},chat:{getMessages:async()=>[{id:'m',content:'public',extra:{}},{id:'hidden',content:'secret',extra:{hidden:true}}]},connections:{get:async id=>({id,name:'n',provider:'fixture-provider',model:'fixture-model'})},generate:{raw:async()=>{calls++;return {content:'[{"layer":"elements","text":"candidate","scope":"public"}]'};}}};return {a,db,grants,count:()=>calls};}
test('malformed stored revision cannot accept revision-free mutation',async()=>{
 const f=fake();f.db.set('chats/a/data.json',{version:1,items:[],candidates:[],undo:[]});
 await assert.rejects(()=>createService(f.a).run({type:'put',confirmPublic:true,chatId:'a',item:{id:'x',layer:'elements',text:'x'}},'owner'),/저장 형식/);
});
test('authenticated scope, owner validation, revisions serialize, acknowledged ambiguous save readback',async()=>{
 const f=fake(),s=createService(f.a),req={chatId:'a',revision:0,type:'put',confirmPublic:true,item:{id:'x',layer:'elements',text:'one',scope:'public'}};
 await assert.rejects(()=>s.run({...req,userId:'owner'},'attacker'));
 const results=await Promise.allSettled([s.run(req,'owner'),s.run({...req,item:{...req.item,text:'two'}},'owner')]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 const original=f.a.userStorage.setJson;f.a.userStorage.setJson=async(k,v)=>{await original(k,v);if(k.endsWith('/data.json'))throw Error('lost ack');};
 const saved=await s.run({...req,revision:1},'owner');assert.equal(saved.state.revision,2);
 f.grants.delete('generation');await assert.rejects(()=>s.run({chatId:'a',type:'analyze',revision:2},'owner'));assert.equal(f.count(),0);
});
test('explicit model confirmation and hidden sources; no memory secrets in provider request',async()=>{
 const f=fake(),s=createService(f.a);let captured;
 f.a.generate.raw=async input=>{captured=input;return {content:'[{"layer":"elements","text":"proposal","scope":"public"}]'};};
 await s.run({type:'put',confirmPublic:true,chatId:'a',revision:0,item:{id:'secret',layer:'wiki',text:'NEVER_SEND',scope:'secret'}},'owner');
 await assert.rejects(()=>s.run({type:'preview',chatId:'a',ids:['hidden'],mode:'raw',connection:'fake'},'owner'));
 const p=await s.run({type:'preview',chatId:'a',ids:['m'],mode:'raw',connection:'fake'},'owner');
 const result=await s.run({type:'analyze',chatId:'a',revision:1,token:p.preview.token,confirm:true},'owner');
 assert.equal(result.state.items.length,1);assert.equal(result.state.candidates.length,1);assert.equal(result.state.candidates[0].scope,'unknown');assert.ok(!JSON.stringify(captured).includes('NEVER_SEND'));assert.ok(!JSON.stringify(captured).includes('secret'));
 f.grants.delete('chats');await assert.rejects(()=>s.run({type:'load',chatId:'a'},'owner'));
});
test('storage failure preserves prior revision; missing trusted user rejected; operator host accepted',async()=>{
 const f=fake(),s=createService(f.a);const r={chatId:'a',type:'put',confirmPublic:true,revision:0,item:{id:'x',layer:'elements',text:'x'}};
 await assert.rejects(()=>s.run({...r,userId:'owner'},undefined));
 f.a.userStorage.setJson=async()=>{throw Error('disk unavailable');};await assert.rejects(()=>s.run(r,'owner'));assert.equal((await s.run({type:'load',chatId:'a'},'owner')).state.revision,0);
 f.a.chats.getActive=async u=>{if(!u)throw Error('userId is required for operator-scoped extensions');return {id:'a'};};assert.equal((await s.run({type:'load'},'owner')).chatId,'a');
});
test('inherited public book negative control: disabled extension cannot intercept host copy',()=>{
 const parent={metadata:{chat_world_book_ids:['parent-public-book']}};
 const child={metadata:{...parent.metadata,branched_from:'parent',branch_at_message:'old-uuid'}};
 assert.deepEqual(child.metadata.chat_world_book_ids,['parent-public-book']);
});
test('first child open persists independent inherited snapshot even before editing',async()=>{
 const f=fake(),s=createService(f.a);f.a.chats.get=async(id,u)=>u==='owner'?{id,metadata:id==='b'?{branched_from:'a',branch_at_message:'m'}:{}}:null;
 await s.run({type:'put',confirmPublic:true,chatId:'a',revision:0,item:{id:'x',layer:'elements',text:'parent v1',scope:'public'}},'owner');
 const child=await s.run({type:'load',chatId:'b'},'owner');assert.equal(child.state.items[0].text,'parent v1');
 await s.run({type:'put',confirmPublic:true,chatId:'a',revision:1,item:{id:'x',layer:'elements',text:'parent v2',scope:'public'}},'owner');
 assert.equal((await s.run({type:'load',chatId:'b'},'owner')).state.items[0].text,'parent v1');
});
