import {test} from 'node:test';import assert from 'node:assert/strict';
import {createService,SKIP_NOTICE} from '../src/service.js';
import {fake,history} from './backend.test.js';

const setup=async()=>{
 const f=fake();f.grants.add('interceptor');const toasts=[];f.a.toast={warning:(message,o)=>toasts.push({message,...o})};
 const s=createService(f.a);
 await s.run({type:'put',confirmPublic:true,chatId:'a',revision:0,item:{id:'x',layer:'elements',scope:'public',text:'OWN_MEMORY'}},'owner');
 return {f,s,toasts};
};
// Prompt shapes that carry the chat text but no host-stamped history turn.
const collapsed=[{role:'user',content:'preset\n\nturn 0'}];
const soleContinue=[{role:'assistant',content:'answer'}];

for(const [name,messages] of [['collapsed messages',collapsed],['continue of the only history turn',soleContinue]])
 test(name+': nothing injected, the user is warned once and the panel shows the skip',async()=>{
  const {f,s,toasts}=await setup(),reads=[];const get=f.a.chats.get;f.a.chats.get=async(...a)=>{reads.push(a);return get(...a);};
  const out=await s.intercept(messages,{chatId:'a',userId:'owner'});
  assert.deepEqual(out,{messages});assert.equal(reads.length,0);
  assert.equal(toasts.length,1);assert.equal(toasts[0].message,SKIP_NOTICE);assert.equal(toasts[0].userId,'owner');
  await s.intercept(messages,{chatId:'a',userId:'owner'});assert.equal(toasts.length,1);
  const panel=await s.run({type:'load',chatId:'a'},'owner');assert.equal(panel.injection.status,'skipped');
 });

test('normal stamped history injects, records the count and re-arms the warning',async()=>{
 const {s,toasts}=await setup();
 await s.intercept(collapsed,{chatId:'a',userId:'owner'});assert.equal(toasts.length,1);
 assert.match(JSON.stringify(await s.intercept(history('m'),{chatId:'a',userId:'owner'})),/OWN_MEMORY/);
 const panel=await s.run({type:'load',chatId:'a'},'owner');assert.deepEqual([panel.injection.status,panel.injection.count],['injected',1]);
 await s.intercept(collapsed,{chatId:'a',userId:'owner'});assert.equal(toasts.length,2);
});

test('no warning for a chat the panel knows has no public memory; mismatch is not a skip notice',async()=>{
 const f=fake();f.grants.add('interceptor');const toasts=[];f.a.toast={warning:m=>toasts.push(m)};const s=createService(f.a);
 await s.run({type:'load',chatId:'b'},'owner');
 await s.intercept(collapsed,{chatId:'b',userId:'owner'});assert.equal(toasts.length,0);
 assert.equal((await s.run({type:'load',chatId:'b'},'owner')).injection.status,'skipped');
 await s.intercept(history('nope'),{chatId:'a',userId:'owner'});assert.equal(toasts.length,0);
 assert.equal((await s.run({type:'load',chatId:'a'},'owner')).injection,undefined);
});

test('hosts without a toast API still skip quietly without throwing',async()=>{
 const f=fake();f.grants.add('interceptor');const s=createService(f.a);
 assert.deepEqual(await s.intercept(collapsed,{chatId:'a',userId:'owner'}),{messages:collapsed});
});
