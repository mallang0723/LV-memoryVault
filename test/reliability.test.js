import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createService} from '../src/service.js';
import {fake,history} from './backend.test.js';
import {fingerprint,review,empty,apply} from '../src/core.js';
import {createHash} from 'node:crypto';
test('public proposal approval needs separate disclosure confirmation',()=>{
 const s=apply(empty(),{type:'propose',items:[{id:'p',layer:'wiki',text:'PUBLIC',scope:'public'}]});
 assert.throws(()=>apply(s,{type:'approve',ids:['p']}),/공개/);
 assert.equal(apply(s,{type:'approve',ids:['p'],confirmPublic:true}).items.length,1);
});
test('new manual evidence and legacy undo snapshots are compacted on save without changing provenance',async()=>{
 const f=fake(),s=createService(f.a),text='legacy source'.repeat(1000);
 const value={id:'x',layer:'anchors',text:'fact',scope:'public',lastChangedAt:123,evidence:[{id:'m',index:0,fingerprint:text}],changeEvidence:{id:'m',fingerprint:text}};
 f.db.set('chats/a/data.json',{...empty(),items:[value],undo:[{items:[value],candidates:[]}]});
 const saved=await s.run({type:'put',chatId:'a',revision:0,item:{...value,id:'new'},confirmPublic:true},'owner');
 for(const x of [...saved.state.items,...saved.state.undo.flatMap(x=>x.items)])assert.match(x.evidence[0].fingerprint,/^sha256:[a-f0-9]{64}$/);
 assert.equal(saved.state.items[0].lastChangedAt,123);
});
test('oversize write is rejected before changing data or backup and damaged data can be recovered explicitly',async()=>{
 const f=fake(),s=createService(f.a);
 const old={...empty(),items:[{id:'old',layer:'anchors',text:'old',padding:'x'.repeat(1100000)}]};f.db.set('chats/a/data.json',old);
 await assert.rejects(()=>s.run({type:'put',chatId:'a',revision:0,item:{id:'x',layer:'elements',text:'x',padding:'y'.repeat(1000000)}},'owner'),/크기/);
 assert.deepEqual(f.db.get('chats/a/data.json'),old);assert.equal(f.db.has('chats/a/backup.json'),false);
 const broken={...empty(),padding:'z'.repeat(2100000)};f.db.set('chats/a/data.json',broken);f.db.set('chats/a/backup.json',empty());
 const load=await s.run({type:'load',chatId:'a'},'owner');assert.equal(load.recovery,true);assert.equal(load.state,null);
 await assert.rejects(()=>s.run({type:'restoreBackup',chatId:'a'},'owner'),/확인/);
 const restored=await s.run({type:'restoreBackup',chatId:'a',confirmRecovery:true},'owner');assert.equal(restored.state.items.length,0);
 assert.deepEqual(f.db.get('chats/a/recovery.json'),broken);assert.deepEqual(f.db.get('chats/a/backup.json'),empty());
 f.db.set('chats/a/data.json',{broken:true});f.db.delete('chats/a/backup.json');
 await assert.rejects(()=>s.run({type:'restoreBackup',chatId:'a',confirmRecovery:true},'owner'),/백업/);
 await s.run({type:'reset',chatId:'a',confirmRecovery:true},'owner');assert.equal((await s.run({type:'load',chatId:'a'},'owner')).state.revision,0);
});
test('SHA256 fingerprints bound long-source storage and legacy evidence still matches',async()=>{
 const text='한글 source'.repeat(2900),hash=await fingerprint(text);
 assert.equal(hash,'sha256:'+createHash('sha256').update(text).digest('hex'));
 const legacy={...empty(),items:[{id:'old',layer:'anchors',text:'legacy',scope:'public',evidence:[{id:'m',index:0,fingerprint:text}]}]};
 assert.equal((await review(legacy,[{id:'m',content:text}])).items[0].review,false);
 assert.equal((await review(legacy,[{id:'m',content:text+' changed'}])).items[0].review,true);
 const f=fake(),s=createService(f.a);f.a.chat.getMessages=async()=>[{id:'m',content:text}];
 f.a.generate.raw=async()=>({content:JSON.stringify(Array.from({length:10},()=>({layer:'elements',text:'candidate'})))});
 for(let i=0;i<5;i++){
  const p=await s.run({type:'preview',chatId:'a',mode:'raw',connection:'fake',ids:['m']},'owner');
  await s.run({type:'analyze',chatId:'a',revision:i,token:p.preview.token,confirm:true},'owner');
 }
 const stored=f.db.get('chats/a/data.json');assert.ok(JSON.stringify(stored).length<200000);assert.ok(!JSON.stringify(stored).includes(text));
 assert.equal((await s.run({type:'export',chatId:'a'},'owner')).state.revision,5);
});
test('generation retains original messages on permission, corrupt storage and lookup failures',async()=>{
 for(const failure of ['interceptor','chat_mutation','chats','storage','active','parent','context','abort']){
  const f=fake();f.grants.add('interceptor');const s=createService(f.a),messages=[...history('m'),{role:'user',content:'ORIGINAL'}];
  if(f.grants.has(failure))f.grants.delete(failure);
  if(failure==='storage')f.db.set('chats/a/data.json',{broken:true});
  if(failure==='active')f.a.chats.getActive=async()=>{throw Error('lookup');};
  if(failure==='parent'){f.a.chats.get=async id=>{if(id==='parent')throw Error('parent');return {id,metadata:{branched_from:'parent'}};};f.db.set('chats/parent/data.json',{broken:true});}
  const context={chatId:'a',userId:'owner'};
  if(failure==='context')delete context.userId;
  if(failure==='abort')context.signal=AbortSignal.abort();
  const result=await s.intercept(messages,context);assert.strictEqual(result.messages,messages,failure);
 }
});
