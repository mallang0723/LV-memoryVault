import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createService} from '../src/service.js';
import {setup} from '../src/frontend.js';
import {fake} from './backend.test.js';

// Lumiverse raw generation uses connection_id only for credentials and takes the
// model from the request, so raw must forward the selected connection's model.
const host=connection=>{const f=fake(),gets=[],calls=[];
 f.a.connections={get:async(id,u)=>{gets.push({id,u});return typeof connection==='function'?connection():connection;}};
 for(const kind of ['raw','quiet'])f.a.generate[kind]=async input=>{calls.push({kind,input});return {content:'[]'};};
 return {f,s:createService(f.a),gets,calls};};

test('raw analyze forwards the selected connection model and provider',async()=>{
 const h=host({id:'conn',name:'n',provider:'deepseek',model:'deepseek-chat'});
 const {preview}=await h.s.run({type:'preview',chatId:'a',mode:'raw',connection:'conn',ids:['m']},'owner');
 await h.s.run({type:'analyze',chatId:'a',revision:0,token:preview.token,confirm:true},'owner');
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].kind,'raw');
 const input=h.calls[0].input;
 assert.equal(input.model,'deepseek-chat');assert.equal(input.provider,'deepseek');assert.equal(input.connection_id,'conn');assert.equal(input.userId,'owner');
 assert.ok(h.gets.length>=1&&h.gets.every(g=>g.id==='conn'&&g.u==='owner'));
});

for(const [label,connection] of [['missing connection',null],['empty model',{id:'conn',name:'n',provider:'custom',model:''}],['blank model',{id:'conn',name:'n',provider:'custom',model:'  '}],['no model field',{id:'conn',name:'n',provider:'custom'}]]){
 test('raw preview with '+label+' is rejected without model calls',async()=>{
  const h=host(connection);
  await assert.rejects(()=>h.s.run({type:'preview',chatId:'a',mode:'raw',connection:'conn',ids:['m']},'owner'),/모델이 지정되어 있지 않습니다/);
  assert.equal(h.calls.length,0);
 });
}

test('raw analyze re-checks the connection and blocks when its model was cleared after preview',async()=>{
 let current={id:'conn',name:'n',provider:'custom',model:'m1'};
 const h=host(()=>current);
 const {preview}=await h.s.run({type:'preview',chatId:'a',mode:'raw',connection:'conn',ids:['m']},'owner');
 current={...current,model:''};
 await assert.rejects(()=>h.s.run({type:'analyze',chatId:'a',revision:0,token:preview.token,confirm:true},'owner'),/모델이 지정되어 있지 않습니다/);
 assert.equal(h.calls.length,0);
});

test('quiet path is unchanged: no connection lookup and no model override',async()=>{
 const h=host(null);
 const {preview}=await h.s.run({type:'preview',chatId:'a',mode:'quiet',connection:'conn',ids:['m']},'owner');
 await h.s.run({type:'analyze',chatId:'a',revision:0,token:preview.token,confirm:true},'owner');
 assert.equal(h.gets.length,0);assert.equal(h.calls.length,1);assert.equal(h.calls[0].kind,'quiet');
 assert.ok(!('model' in h.calls[0].input));assert.ok(!('provider' in h.calls[0].input));
});

test('connection dropdown marks connections without a model',()=>{
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);const sent=[];let listener;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 const state={revision:0,items:[],candidates:[],undo:[]};
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state});
 const click=text=>[...root.querySelectorAll('button')].find(x=>x.textContent===text).click();
 click('약속');click('원문에서 정리');click('모델 목록 읽기');
 listener({requestId:sent.at(-1).requestId,ok:true,chatId:'a',state,connections:[{id:'c1',name:'A',model:'gpt-x'},{id:'c2',name:'B',model:''}]});
 const options=[...root.querySelectorAll('option')].map(x=>x.textContent);
 assert.ok(options.includes('A · gpt-x'));assert.ok(options.includes('B · (모델 미지정)'));
 cleanup();
});
