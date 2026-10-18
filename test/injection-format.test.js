import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createService} from '../src/service.js';
import {fake,history} from './backend.test.js';
test('interceptor emits only Korean kind and memory text, never header or metadata',async()=>{
 const f=fake();f.grants.add('interceptor');const s=createService(f.a);
 const kinds=[['promises','약속'],['flows','진행 흐름'],['anchors','기억 앵커'],['scenes','장면 기억'],['elements','요소 기억'],['wiki','이야기 위키']];
 for(const [i,[layer]] of kinds.entries())await s.run({type:'put',chatId:'a',revision:i,confirmPublic:true,item:{id:'INTERNAL_'+i,layer,title:'FILE_CHARACTER_CHAT_NAME',text:'기억 '+i,scope:'public',source:'INTERNAL_SOURCE'}},'owner');
 const result=await s.intercept([...history('m'),{role:'user',content:'hello'}],{chatId:'a',userId:'owner'});
 assert.equal(result.messages.at(-1).content,kinds.map(([,name],i)=>name+': 기억 '+i).join('\n'));
 assert.equal(result.messages.at(-1).role,'system');assert.equal(f.count(),0);
});
