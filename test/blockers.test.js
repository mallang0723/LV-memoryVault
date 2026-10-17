import {test} from 'node:test';
import assert from 'node:assert/strict';
import {apply,empty} from '../src/core.js';
import {createService} from '../src/service.js';
import {fake} from './backend.test.js';
const value={id:'x',layer:'anchors',text:'BEFORE',scope:'public',evidence:[{id:'m',index:0,fingerprint:'public'}]};
test('new public put and completed/cancelled reactivation require confirmation including omitted status',()=>{
 assert.throws(()=>apply(empty(),{type:'put',item:value}),/공개/);
 for(const status of ['completed','cancelled'])for(const next of ['active',undefined]){
  const s=apply(empty(),{type:'put',item:{...value,status},confirmPublic:true});
  assert.throws(()=>apply(s,{type:'put',item:{...value,status:next}}),/공개/);
 }
});
test('valid evidence branch first load rejects later edit without message growth and caller timestamp',async()=>{
 const f=fake();f.grants.add('interceptor');let now=1000;const original=Date.now;Date.now=()=>now;
 try{
 f.a.chat.getMessages=async id=>[{id:id==='a'?'m':'c',content:'public'}];
 f.a.chats.get=async(id,u)=>u==='owner'?{id,created_at:2,metadata:id==='b'?{branched_from:'a',branch_at_message:'m'}:{}}:null;
 const s=createService(f.a);await s.run({type:'put',chatId:'a',revision:0,item:value,confirmPublic:true},'owner');
 const parent=structuredClone(f.db.get('chats/a/data.json'));
 assert.match(JSON.stringify(await s.intercept([],{chatId:'b',userId:'owner'})),/BEFORE/);
 f.db.delete('chats/b/data.json');now=3000;
 await s.run({type:'put',chatId:'a',revision:1,item:{...value,text:'AFTER',lastChangedAt:1},confirmPublic:true},'owner');
 assert.equal(f.db.get('chats/a/data.json').items[0].lastChangedAt,3000);
 assert.doesNotMatch(JSON.stringify(await s.intercept([],{chatId:'b',userId:'owner'})),/AFTER/);
 const forged=f.db.get('chats/b/data.json');forged.items[0].branchHold=false;f.db.set('chats/b/data.json',forged);
 assert.doesNotMatch(JSON.stringify(await s.intercept([],{chatId:'b',userId:'owner'})),/AFTER/);
 for(const timestamp of [undefined,2000]){
  const ambiguous=structuredClone(parent);ambiguous.items[0].lastChangedAt=timestamp;
  f.db.set('chats/a/data.json',ambiguous);f.db.delete('chats/b/data.json');
  assert.doesNotMatch(JSON.stringify(await s.intercept([],{chatId:'b',userId:'owner'})),/BEFORE/);
 }
 f.db.set('chats/a/data.json',parent);f.db.delete('chats/b/data.json');
 f.a.chat.getMessages=async id=>[{id:id==='a'?'m':'c',content:id==='a'?'public':'changed'}];
 assert.doesNotMatch(JSON.stringify(await s.intercept([],{chatId:'b',userId:'owner'})),/BEFORE/);
 }finally{Date.now=original;}
});
test('undo after import and truncation preserves future provenance',async()=>{
 const f=fake(),s=createService(f.a);await s.run({type:'put',chatId:'a',revision:0,item:value,confirmPublic:true},'owner');
 const original=structuredClone(f.db.get('chats/a/data.json').items[0]);
 await s.run({type:'import',chatId:'a',revision:1,data:empty()},'owner');
 f.a.chat.getMessages=async()=>[{id:'m',content:'public'}];
 const restored=await s.run({type:'undo',chatId:'a',revision:2},'owner');
 assert.deepEqual(restored.state.items[0],original);
 f.grants.add('interceptor');f.a.chats.get=async(id,u)=>u==='owner'?{id,created_at:Math.floor(Date.now()/1000)+10,metadata:id==='b'?{branched_from:'a',branch_at_message:'m'}:{}}:null;
 assert.doesNotMatch(JSON.stringify(await s.intercept([],{chatId:'b',userId:'owner'})),/BEFORE/);
});
