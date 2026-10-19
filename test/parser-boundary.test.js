import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseCandidates} from '../src/core.js';
import {createService} from '../src/service.js';
import {fake} from './backend.test.js';

const analyze=async output=>{
 const f=fake();f.a.generate.raw=async()=>({content:output});const s=createService(f.a);
 const {preview}=await s.run({type:'preview',chatId:'a',mode:'raw',connection:'conn',ids:['m']},'owner');
 const writes=[];const set=f.a.userStorage.setJson;f.a.userStorage.setJson=async(k,v,o)=>{writes.push(k);return set(k,v,o);};
 try{return {result:await s.run({type:'analyze',chatId:'a',revision:0,token:preview.token,confirm:true},'owner'),writes};}
 catch(error){return {error,writes};}
};

test('reasoning tags inside a valid JSON string are kept verbatim',()=>{
 const input=[{layer:'elements',text:'문자 그대로 <think>보존할 사건</think> 끝'}];
 assert.deepEqual(parseCandidates(JSON.stringify(input)),input);
 assert.deepEqual(parseCandidates('```json\n'+JSON.stringify(input)+'\n```'),input);
 assert.deepEqual(parseCandidates('<think>draft [x]</think>\n'+JSON.stringify(input)),input);
 assert.deepEqual(parseCandidates('Here you go:\n'+JSON.stringify(input)+'\nDone.'),input);
 assert.deepEqual(parseCandidates(JSON.stringify({memories:input})),input);
});
test('a cut-off outer array never falls back to an array nested inside it',async()=>{
 const nested={layer:'elements',text:'중첩 참고만',scope:'public'};
 const output='[{"layer":"elements","text":"주 후보","alternatives":'+JSON.stringify([nested]);
 assert.throws(()=>parseCandidates(output),/해석하지 못했습니다/);
 assert.throws(()=>parseCandidates('```json\n'+output+'\n```'),/해석하지 못했습니다/);
 assert.throws(()=>parseCandidates('<think>plan</think>'+output),/해석하지 못했습니다/);
 assert.throws(()=>parseCandidates('{"candidates":'+output),/해석하지 못했습니다/);
 const {error,writes}=await analyze(output);assert.match(error.message,/해석하지 못했습니다/);assert.equal(writes.length,0);
});
test('a valid outer list is used whole, mixed entries are reported, nested lists are not promoted',async()=>{
 const output=JSON.stringify([null,{layer:'wiki',text:'outer',details:[{layer:'wiki',text:'inner'}]}]);
 assert.equal(parseCandidates(output).length,2);
 const {result}=await analyze(output);
 assert.deepEqual(result.state.candidates.map(x=>x.text),['outer']);
 assert.match(result.notice,/2개 중 1개 형식 오류로 제외/);
 // a top-level object without a candidates key is not searched for inner arrays
 assert.throws(()=>parseCandidates(JSON.stringify({note:{list:[{layer:'wiki',text:'inner'}]}})),/해석하지 못했습니다/);
 // prose segments that are not usable JSON are skipped whole, never searched inside
 assert.deepEqual(parseCandidates('Note {"x":[{"layer":"wiki","text":"no"}]} then '+JSON.stringify([{layer:'wiki',text:'yes'}])).map(x=>x.text),['yes']);
});
test('raw responses over 2MB are rejected before any reasoning is removed',async()=>{
 const output='<think>'+'x'.repeat(2000001)+'</think>'+JSON.stringify([{layer:'wiki',text:'ok'}]);
 assert.throws(()=>parseCandidates(output),/크기 제한 2MB/);
 assert.throws(()=>parseCandidates('가'.repeat(700000)),/크기 제한 2MB/);
 const {error,writes}=await analyze(output);assert.match(error.message,/크기 제한 2MB/);assert.equal(writes.length,0);
});
