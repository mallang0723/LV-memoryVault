import {test} from 'node:test';
import assert from 'node:assert/strict';
import {empty,apply,publicItems} from '../src/core.js';
import {createService} from '../src/service.js';
import {fake,history} from './backend.test.js';
const value={id:'x',layer:'elements',text:'PRIVATE',scope:'secret'};
test('promotion and removal of restrictions need dedicated confirmation',()=>{
 for(const type of ['put','editCandidate']){
  const s=apply(empty(),type==='put'?{type,item:value}:{type:'propose',items:[value]});
  assert.throws(()=>apply(s,{type,item:{...value,scope:'public'}}),/공개/);
  assert.doesNotThrow(()=>apply(s,{type,item:{...value,scope:'public'},confirmPublic:true}));
 }
 const s=apply(empty(),{type:'put',confirmPublic:true,item:{...value,scope:'public',knownBy:['a']}});
 assert.throws(()=>apply(s,{type:'put',item:{...value,scope:'public'}}),/공개/);
});
test('quarantined candidates roundtrip, resume approval and status validation',()=>{
 const s=apply(empty(),{type:'propose',items:[{...value,resumeRequired:true}]});
 assert.throws(()=>apply(s,{type:'approve',ids:['x']}),/보류/);
 assert.equal(apply(empty(),{type:'import',data:s}).candidates.length,1);
 assert.throws(()=>apply(empty(),{type:'put',confirmPublic:true,item:{...value,status:'bogus'}}),/상태/);
 for(const field of ['review','resumeRequired','branchHold','importedScope','hold']) assert.equal(publicItems({items:[{...value,scope:'public',[field]:true}]}).length,0);
});
for(const mode of ['raw','quiet']){
 test(mode+' preview requires explicit valid ID without provider calls',async()=>{
  const f=fake(),s=createService(f.a);let calls=0;
  f.a.generate.raw=f.a.generate.quiet=async()=>{calls++;return {content:'[]'};};
  for(const connection of [undefined,'','   ','bad/id',42]) await assert.rejects(()=>s.run({type:'preview',chatId:'a',mode,connection,ids:['m']},'owner'),/모델 연결/);
  assert.equal(calls,0);
 });
 test(mode+' explicit preview token forwards immutable mode, ID and input',async()=>{
  const f=fake(),s=createService(f.a),calls=[];
  for(const kind of ['raw','quiet'])f.a.generate[kind]=async input=>{calls.push({kind,input});return {content:'[]'};};
  const request={type:'preview',chatId:'a',mode,connection:'selected-local',ids:['m']};
  const {preview}=await s.run(request,'owner');const token=preview.token;
  assert.equal(preview.connection,'selected-local');assert.equal(preview.input,'[메시지 전송 시각 기준: UTC (사용자 시간대 미확인)]\n\n[전송 시각 미상] public');assert.equal(preview.mode,mode);assert.equal(calls.length,0);
  request.connection='changed';request.ids[0]='hidden';preview.connection='tampered';preview.input='tampered';preview.mode='tampered';
  await s.run({type:'analyze',chatId:'a',revision:0,token,confirm:true,mode:mode==='raw'?'quiet':'raw',connection:'override',input:'override',ids:['hidden']},'owner');
  assert.equal(calls.length,1);assert.equal(calls[0].kind,mode);assert.equal(calls[0].input.connection_id,'selected-local');
  assert.equal(calls[0].input.messages[1].content,'[메시지 전송 시각 기준: UTC (사용자 시간대 미확인)]\n\n[전송 시각 미상] public');assert.match(calls[0].input.messages[0].content,/JSON array of memory candidates/);
  await assert.rejects(()=>s.run({type:'analyze',chatId:'a',revision:1,token,confirm:true},'owner'),/명시 확인/);assert.equal(calls.length,1);
 });
}
test('edit evidence ignores caller index',async()=>{
 const f=fake(),s=createService(f.a);
 const r=await s.run({type:'put',confirmPublic:true,chatId:'a',revision:0,item:{...value,lastChangeIndex:0}},'owner');
 assert.equal(r.state.items[0].lastChangeIndex,1);
});
test('interceptor uses actual chat and withholds other users and revoked permissions',async()=>{
 const f=fake();f.grants.add('interceptor');const s=createService(f.a);
 await s.run({type:'put',confirmPublic:true,chatId:'a',revision:0,item:{...value,scope:'public'}},'owner');
 assert.equal(typeof s.intercept,'function');
 assert.match(JSON.stringify(await s.intercept(history('m'),{chatId:'a',userId:'owner'})),/PRIVATE/);
 assert.doesNotMatch(JSON.stringify(await s.intercept(history('m'),{chatId:'b',userId:'owner'})),/PRIVATE/);
 assert.deepEqual(await s.intercept(history('m'),{chatId:'a',userId:'attacker'}),{messages:history('m')});
 f.grants.delete('interceptor');assert.deepEqual(await s.intercept(history('m'),{chatId:'a',userId:'owner'}),{messages:history('m')});
 await assert.rejects(()=>s.run({type:'sync',chatId:'a',revision:1},'owner'));
});
