import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseCandidates} from '../src/core.js';
import {createService} from '../src/service.js';
import {fake} from './backend.test.js';

const arr='[{"layer":"elements","text":"blue notebook [kept]","scope":"public"}]';
const expected=[{layer:'elements',text:'blue notebook [kept]',scope:'public'}];

test('plain array and surrounding whitespace parse as before',()=>{
 assert.deepEqual(parseCandidates(arr),expected);
 assert.deepEqual(parseCandidates('\n\n  '+arr+'  \n'),expected);
 assert.deepEqual(parseCandidates('[]'),[]);
});
test('```json and bare ``` fences are removed',()=>{
 assert.deepEqual(parseCandidates('```json\n'+arr+'\n```'),expected);
 assert.deepEqual(parseCandidates('```\n'+arr+'\n```\n'),expected);
 assert.deepEqual(parseCandidates('```JSON '+arr+'```'),expected);
});
test('reasoning blocks are removed, including a stray closing tag',()=>{
 assert.deepEqual(parseCandidates('<think>maybe [1,2] or `x`</think>\n'+arr),expected);
 assert.deepEqual(parseCandidates('<thinking>\nplan\n</thinking>```json\n'+arr+'\n```'),expected);
 assert.deepEqual(parseCandidates('leaked reasoning [draft]\n</think>\n'+arr),expected);
});
test('prose before and after the array is ignored',()=>{
 assert.deepEqual(parseCandidates('Here are the candidates:\n'+arr+'\nLet me know if [anything] else.'),expected);
 assert.deepEqual(parseCandidates('Sure! ```json\n'+arr+'\n``` Done.'),expected);
});
test('unparseable output fails with a user-facing message and a short excerpt',()=>{
 assert.throws(()=>parseCandidates('I cannot help with that.'),/JSON 배열로 해석하지 못했습니다.*다시 시도.*응답 앞부분: I cannot help/);
 assert.throws(()=>parseCandidates('```json\n[{"layer":"elements","text":"cut'),/해석하지 못했습니다/);
 assert.throws(()=>parseCandidates('x'.repeat(500)),e=>e.message.endsWith('…')&&e.message.length<400);
 assert.throws(()=>parseCandidates(''),/빈 응답/);
 // a truncated outer array must not fall back to a nested array
 assert.throws(()=>parseCandidates('[{"layer":"elements","knownBy":["a"],"text":"cut'),/해석하지 못했습니다/);
 assert.throws(()=>parseCandidates('{"items":1}'),/해석하지 못했습니다/);
});
test('dangerous keys are still rejected, not skipped',()=>{
 assert.throws(()=>parseCandidates('```json\n[{"__proto__":{"x":1}}]\n```'),/위험한 키/);
});
for(const mode of ['raw','quiet'])test(mode+' analyze accepts fenced output with reasoning',async()=>{
 const f=fake();f.a.connections={get:async id=>({id,name:'n',provider:'p',model:'m'})};
 f.a.generate[mode]=async()=>({content:'<think>hmm</think>\n```json\n'+arr+'\n```'});
 const s=createService(f.a);
 const r=await s.run({type:'analyze',chatId:'a',revision:0,mode,connection:'conn',source:{scope:'last',n:2}},'owner');
 assert.equal(r.state.candidates.length,1);assert.equal(r.state.candidates[0].text,'blue notebook [kept]');
});
