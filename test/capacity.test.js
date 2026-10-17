import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createService} from '../src/service.js';
import {empty,fingerprint,publicItems} from '../src/core.js';
import {fake} from './backend.test.js';
const bytes=x=>new TextEncoder().encode(JSON.stringify(x)).byteLength;
test('payload without undo retains headroom for holding every memory',async()=>{
 const f=fake(),s=createService(f.a),value={id:'x',layer:'anchors',text:'fact',scope:'public',evidence:[]};
 const first=await s.run({type:'put',chatId:'a',revision:0,item:value,confirmPublic:true},'owner');
 const prior=first.state.items[0];
 // Fill using normal writes until only a few bytes remain. No history can help.
 const item={...value,padding:'x'.repeat(2000000-bytes({...first.state,items:[{...prior,padding:''}],undo:[]})-5)};
 await assert.rejects(()=>s.run({type:'put',chatId:'a',revision:1,item,confirmPublic:true},'owner'),/보류.*여유/);
 const full=await s.run({type:'put',chatId:'a',revision:1,item:{...item,padding:item.padding.slice(0,-530)},confirmPublic:true},'owner');
 assert.equal(full.state.undo.length,0);
 const result=await s.run({type:'hold',chatId:'a',revision:2,ids:['x']},'owner');
 assert.equal(result.state.items[0].hold,true);assert.ok(bytes(result.state)<=2000000);
 assert.deepEqual(result.state.items[0],{...full.state.items[0],hold:true});
});
test('near-full legacy snapshots cannot block deletion or holding items and candidates',async()=>{
 for(const type of ['delete','hold']){
  const f=fake(),s=createService(f.a),value={id:'item',layer:'anchors',text:'한'.repeat(200),scope:'public',evidence:[]};
  const old={...empty(),items:[value],candidates:[{...value,id:'candidate',scope:'unknown'}],undo:[{items:[],candidates:[],padding:'x'.repeat(1997000)}]};
  assert.ok(bytes(old)<2000000);f.db.set('chats/a/data.json',old);
  const saved=await s.run({type,chatId:'a',revision:0,ids:['item','candidate']},'owner');
  assert.equal(saved.saved,true);assert.ok(bytes(saved.state)<=2000000);
  assert.deepEqual(f.db.get('chats/a/backup.json'),old);
  assert.equal(publicItems(saved.state).length,0);
  if(type==='delete')assert.equal(saved.state.items.length+saved.state.candidates.length,0);
  else assert.ok([...saved.state.items,...saved.state.candidates].every(x=>x.hold));
 }
});
test('current payload overflow preserves both files and explains how to free space',async()=>{
 const f=fake(),s=createService(f.a),old={...empty(),items:[{id:'old',layer:'anchors',text:'old',padding:'x'.repeat(1100000)}]};
 f.db.set('chats/a/data.json',old);f.db.set('chats/a/backup.json',empty());
 await assert.rejects(()=>s.run({type:'put',chatId:'a',revision:0,item:{id:'new',layer:'anchors',text:'new',padding:'y'.repeat(1000000)}},'owner'),/현재 기억.*2.*삭제.*내보내기/);
 assert.deepEqual(f.db.get('chats/a/data.json'),old);assert.deepEqual(f.db.get('chats/a/backup.json'),empty());
});
test('130 Korean memories save past the old 105th limit, retaining newest undo and independent backup',async()=>{
 const f=fake(),s=createService(f.a),digest=await fingerprint('public');let state=empty(),trimmed=false;
 for(let i=0;i<130;i++){
  const prior=structuredClone(state);
  const result=await s.run({type:'put',chatId:'a',revision:state.revision,item:{id:'long-'+i,layer:'anchors',text:'한'.repeat(200),evidence:[{id:'m',index:0,fingerprint:digest}]}},'owner');
  state=result.state;trimmed ||= state.undo.length<Math.min(i+1,20);
  assert.ok(bytes(state)<=2000000);assert.deepEqual(f.db.get('chats/a/backup.json'),prior);
 }
 assert.equal(trimmed,true);assert.equal(state.items.length,130);
 const latest=structuredClone(state);
 const undone=await s.run({type:'undo',chatId:'a',revision:state.revision},'owner');
 assert.deepEqual(undone.state.items,latest.undo.at(-1).items);
 assert.equal(undone.state.items.length,129);
 assert.equal((await createService(f.a).run({type:'load',chatId:'a'},'owner')).state.items.length,129);
});
