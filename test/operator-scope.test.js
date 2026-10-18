import {test} from 'node:test';import assert from 'node:assert/strict';
import {createService} from '../src/service.js';
import {start} from '../src/backend.js';

// Mirrors Lumiverse 1.2.5 host semantics for an operator-scoped install:
// every per-user call needs an explicit userId, storage is keyed per user,
// chats.get only returns chats the user owns, and chat.getMessages takes no
// userId and resolves the chat owner itself (so it would serve any chat id).
function operatorHost({scope='operator',installer=null}={}){
 const owners={chatA:'alice',chatA2:'alice',chatB:'bob'};
 const active={alice:'chatA',bob:'chatB'};
 const messages={chatA:[{id:'ma',content:'alice source',extra:{}}],chatA2:[{id:'ma2',content:'alice second',extra:{}}],chatB:[{id:'mb',content:'bob source',extra:{}}]};
 const storage=new Map(),calls=[],grants=new Set(['chats','chat_mutation','generation','interceptor']);
 const who=u=>{
  if(scope==='user'){if(!installer)throw Error('Extension owner is not set');return installer;}
  if(typeof u!=='string'||!u)throw Error('userId is required for operator-scoped extensions');return u;
 };
 const rec=(name,u,extra)=>{calls.push({name,userId:u,...extra});return who(u);};
 const api={
  permissions:{has:p=>grants.has(p)},
  chats:{
   getActive:async u=>{const id=active[rec('chats.getActive',u)];return id?{id,metadata:{}}:null;},
   get:async(id,u)=>{const user=rec('chats.get',u,{chatId:id});return owners[id]===user?{id,metadata:{}}:null;},
  },
  chat:{getMessages:async id=>{calls.push({name:'chat.getMessages',chatId:id});if(!owners[id])throw Error('Chat not found');return structuredClone(messages[id]);}},
  userStorage:{
   exists:async(k,u)=>storage.has(rec('userStorage.exists',u,{key:k})+'/'+k),
   getJson:async(k,o)=>{const key=rec('userStorage.getJson',o?.userId,{key:k})+'/'+k;if(!storage.has(key))throw Error('missing');return structuredClone(storage.get(key));},
   setJson:async(k,v,o)=>{storage.set(rec('userStorage.setJson',o?.userId,{key:k})+'/'+k,structuredClone(v));},
  },
  connections:{list:async u=>{rec('connections.list',u);return [{id:'conn',name:'n',model:'m',api_key:'SECRET'}];}},
  generate:{raw:async input=>{rec('generate.raw',input.userId);return {content:'[{"layer":"elements","text":"proposal","scope":"public"}]'};}},
 };
 return {api,calls,storage,grants,owners};
}
const PER_USER=['chats.getActive','chats.get','userStorage.exists','userStorage.getJson','userStorage.setJson','connections.list','generate.raw'];
const put=(chatId,revision,text)=>({type:'put',confirmPublic:true,chatId,revision,item:{id:'x-'+text,layer:'elements',text,scope:'public'}});

test('operator scope: full flow works and every per-user host call carries the authenticated user',async()=>{
 const h=operatorHost(),s=createService(h.api);
 assert.equal((await s.run({type:'load'},'alice')).chatId,'chatA');
 await s.run(put('chatA',0,'ALICE_PUBLIC'),'alice');
 assert.deepEqual((await s.run({type:'connections',chatId:'chatA'},'alice')).connections,[{id:'conn',name:'n',model:'m'}]);
 const p=await s.run({type:'preview',chatId:'chatA',ids:['ma'],mode:'raw',connection:'conn'},'alice');
 const a=await s.run({type:'analyze',chatId:'chatA',revision:1,token:p.preview.token,confirm:true},'alice');
 assert.equal(a.state.candidates.length,1);
 await s.run({type:'review',chatId:'chatA',revision:2},'alice');
 assert.ok(h.calls.some(c=>c.name==='generate.raw'));
 for(const c of h.calls.filter(c=>PER_USER.includes(c.name)))assert.equal(c.userId,'alice',c.name);
 assert.ok(h.calls.filter(c=>c.name==='chat.getMessages').every(c=>c.chatId==='chatA'));
 assert.ok([...h.storage.keys()].every(k=>k.startsWith('alice/')));
});

test('operator scope: another user cannot read or write a foreign chat, and getMessages is never reached',async()=>{
 const h=operatorHost(),s=createService(h.api);
 await s.run(put('chatA',0,'ALICE_SECRET_TEXT'),'alice');
 const before=h.calls.length;
 for(const type of ['load','sources','export','review'])await assert.rejects(()=>s.run({type,chatId:'chatA',revision:1},'bob'),/소유권/);
 await assert.rejects(()=>s.run({type:'preview',chatId:'chatA',ids:['ma'],mode:'raw',connection:'conn'},'bob'),/소유권/);
 await assert.rejects(()=>s.run(put('chatA',1,'BOB_OVERWRITE'),'bob'),/소유권/);
 await assert.rejects(()=>s.run({type:'reset',chatId:'chatA',confirmRecovery:true},'bob'),/소유권/);
 assert.ok(!h.calls.slice(before).some(c=>c.name==='chat.getMessages'));
 assert.ok(!h.calls.slice(before).some(c=>c.name==='userStorage.setJson'));
 assert.equal((await s.run({type:'load',chatId:'chatA'},'alice')).state.items[0].text,'ALICE_SECRET_TEXT');
 assert.ok(![...h.storage.keys()].some(k=>k.startsWith('bob/')));
 // Bob's own chat is a separate keyspace that never sees Alice's data.
 const bob=await s.run({type:'load'},'bob');assert.equal(bob.chatId,'chatB');assert.equal(bob.state.items.length,0);
 await s.run(put('chatB',0,'BOB_TEXT'),'bob');
 assert.ok(!JSON.stringify([...h.storage].filter(([k])=>k.startsWith('bob/'))).includes('ALICE'));
 assert.ok(!JSON.stringify([...h.storage].filter(([k])=>k.startsWith('alice/'))).includes('BOB'));
});

test('operator scope: a userId inside the payload is ignored',async()=>{
 const h=operatorHost(),s=createService(h.api);
 await s.run(put('chatA',0,'ALICE_TEXT'),'alice');
 await assert.rejects(()=>s.run({type:'load',chatId:'chatA',userId:'alice'},'bob'),/소유권/);
 await assert.rejects(()=>s.run({...put('chatA',1,'SPOOF'),userId:'alice'},'bob'),/소유권/);
 const own=await s.run({...put('chatB',0,'BOB_TEXT'),userId:'alice'},'bob');
 assert.equal(own.chatId,'chatB');
 assert.ok(h.storage.has('bob/chats/chatB/data.json'));
 assert.ok(!h.storage.has('alice/chats/chatB/data.json'));
 // Preview tokens are bound to the user that created them.
 const p=await s.run({type:'preview',chatId:'chatA',ids:['ma'],mode:'raw',connection:'conn'},'alice');
 await assert.rejects(()=>s.run({type:'analyze',chatId:'chatB',revision:1,token:p.preview.token,confirm:true,userId:'alice'},'bob'),/명시 확인/);
});

test('operator scope: missing or malformed identity fails closed before any host call',async()=>{
 const h=operatorHost(),s=createService(h.api);
 for(const user of [undefined,null,'',42,'../alice','a b'])await assert.rejects(()=>s.run({type:'load',chatId:'chatA',userId:'alice'},user),/인증된 사용자/);
 assert.equal(h.calls.length,0);
 assert.deepEqual(await s.intercept([{role:'user',content:'hi'}],{chatId:'chatA'}),{messages:[{role:'user',content:'hi'}]});
 assert.deepEqual(await s.intercept([],{chatId:'chatA',userId:''}),{messages:[]});
 assert.equal(h.calls.length,0);
});

test('backend frontend-message entry uses only the host-routed userId',async()=>{
 const h=operatorHost();let handler;const sent=[];
 h.api.registerInterceptor=()=>()=>{};
 h.api.onFrontendMessage=fn=>{handler=fn;return ()=>{};};
 h.api.sendToFrontend=(reply,userId,options)=>sent.push({reply,userId,options});
 start(h.api);
 await h.api.userStorage.setJson('chats/chatA/data.json',{version:1,revision:0,items:[],candidates:[],undo:[]},{userId:'alice'});
 await handler({requestId:'r0',type:'load',userId:'alice'},undefined,'s0');
 await handler({requestId:'r1',type:'load',userId:'alice'},'',undefined);
 assert.equal(sent.length,0);
 await handler({requestId:'r2',type:'load',chatId:'chatA',userId:'alice'},'bob','s2');
 assert.equal(sent.length,1);assert.equal(sent[0].userId,'bob');assert.equal(sent[0].reply.ok,false);assert.deepEqual(sent[0].options,{frontendSessionId:'s2'});
 await handler({requestId:'r3',type:'load',userId:'bob'},'alice','s3');
 assert.equal(sent[1].userId,'alice');assert.equal(sent[1].reply.ok,true);assert.equal(sent[1].reply.chatId,'chatA');
});

test('operator scope interceptor injects only the generating user\'s own approved memories',async()=>{
 const h=operatorHost(),s=createService(h.api);
 await s.run(put('chatA',0,'ALICE_PUBLIC'),'alice');
 await s.run(put('chatB',0,'BOB_PUBLIC'),'bob');
 const a=JSON.stringify(await s.intercept([],{chatId:'chatA',userId:'alice'}));
 assert.match(a,/ALICE_PUBLIC/);assert.doesNotMatch(a,/BOB_PUBLIC/);
 const b=JSON.stringify(await s.intercept([],{chatId:'chatB',userId:'bob'}));
 assert.match(b,/BOB_PUBLIC/);assert.doesNotMatch(b,/ALICE_PUBLIC/);
 const before=h.calls.length;
 assert.deepEqual(await s.intercept([],{chatId:'chatA',userId:'bob'}),{messages:[]});
 assert.ok(!h.calls.slice(before).some(c=>c.name==='chat.getMessages'));
 for(const c of h.calls.filter(c=>PER_USER.includes(c.name)))assert.ok(['alice','bob'].includes(c.userId),c.name);
});

test('user-scoped install still works: host pins the installer regardless of requested userId',async()=>{
 const h=operatorHost({scope:'user',installer:'alice'}),s=createService(h.api);
 await s.run(put('chatA',0,'ALICE_PUBLIC'),'alice');
 assert.equal((await s.run({type:'load'},'alice')).state.items[0].text,'ALICE_PUBLIC');
 assert.match(JSON.stringify(await s.intercept([],{chatId:'chatA',userId:'alice'})),/ALICE_PUBLIC/);
 const p=await s.run({type:'preview',chatId:'chatA',ids:['ma'],mode:'raw',connection:'conn'},'alice');
 assert.equal((await s.run({type:'analyze',chatId:'chatA',revision:1,token:p.preview.token,confirm:true},'alice')).state.candidates.length,1);
 assert.ok([...h.storage.keys()].every(k=>k.startsWith('alice/')));
});
