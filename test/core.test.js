import {test} from 'node:test';
import assert from 'node:assert/strict';
import {empty, apply, publicItems} from '../src/core.js';
test('approval cannot launder restricted wiki into public output',()=>{
 let s=apply(empty(),{type:'put',confirmPublic:true,item:{id:'secret-wiki',layer:'wiki',text:'PRIVATE',scope:'public',knownBy:['private-character']}});
 s=apply(s,{type:'propose',items:[{id:'proposal',targetId:'secret-wiki',layer:'wiki',text:'PRIVATE merged',baseText:'PRIVATE',scope:'public'}]});
 assert.throws(()=>apply(s,{type:'approve',ids:['proposal']}),/비공개/);
});
test('candidate lock must not bypass explicit approval',()=>{
 const s=apply(empty(),{type:'propose',items:[{id:'c',layer:'wiki',text:'not approved',scope:'public'}]});
 assert.throws(()=>apply(s,{type:'put',confirmPublic:true,item:{...s.candidates[0],locked:true}}),/후보/);
 const edited=apply(s,{type:'editCandidate',item:{...s.candidates[0],locked:true}});
 assert.equal(publicItems(edited).length,0);assert.equal(edited.candidates[0].locked,true);
});
test('six layers preserve canonical text and withhold secret/unknown scopes',()=>{
 let s=empty();
 for(const layer of ['promises','anchors','elements','scenes','flows','wiki']) s=apply(s,{type:'put',confirmPublic:true,item:{id:layer,layer,text:'<img src=x> 원문',scope:'secret'}});
 assert.equal(s.items.length,6); assert.equal(s.items[0].text,'<img src=x> 원문'); assert.equal(publicItems(s).length,0);
});
test('candidate approval is idempotent, wiki lock rejects, undo bounded, import quarantines',()=>{
 let s=empty();s=apply(s,{type:'propose',items:[{id:'c',layer:'wiki',text:'new',scope:'public'}]});
 s=apply(s,{type:'approve',ids:['c'],confirmPublic:true});s=apply(s,{type:'approve',ids:['c']});assert.equal(s.items.length,1);
 s=apply(s,{type:'put',confirmPublic:true,item:{...s.items[0],locked:true}});
 s=apply(s,{type:'propose',items:[{id:'p',targetId:'c',layer:'wiki',text:'changed',scope:'public'}]});
 assert.throws(()=>apply(s,{type:'approve',ids:['p']}),/잠금/);
 for(let i=0;i<25;i++)s=apply(s,{type:'put',confirmPublic:true,item:{id:'x',layer:'flows',text:String(i),scope:'unknown'}});
 assert.equal(s.undo.length,20);s=apply(s,{type:'undo'});assert.equal(s.items.find(x=>x.id==='x').text,'23');
 s=apply(s,{type:'import',data:{version:1,items:[{id:'foreign',layer:'elements',text:'secret',scope:'character',knownBy:['foreign-id']}],candidates:[]}});
 assert.equal(publicItems(s).length,0);assert.equal(s.items[0].knownBy[0],'foreign-id');
 assert.throws(()=>apply(s,{type:'import',data:JSON.parse('{"version":1,"__proto__":{}}')}),/위험/);
 assert.throws(()=>apply(empty(),{type:'import',data:{version:1,items:Array.from({length:401},(_,i)=>({id:String(i),layer:'elements',text:'x'})),candidates:[]}}),/한도/);
});
test('branch new UUID mapping, cut hold, deleted parent fail closed; changed evidence keeps public',async()=>{
 const {inherit,review,fingerprint}=await import('../src/core.js');
 const messages=[{id:'p0',content:'before'},{id:'p1',content:'after'}];let s=empty();
 s=apply(s,{type:'put',confirmPublic:true,item:{id:'a',layer:'anchors',text:'fact',scope:'public',evidence:[{id:'p0',index:0,fingerprint:await fingerprint('before')}]}});
 s=apply(s,{type:'put',confirmPublic:true,item:{id:'b',layer:'flows',text:'future',scope:'public',evidence:[{id:'p1',index:1,fingerprint:await fingerprint('after')}]}});
 const child=await inherit(s,messages,[{id:'c0',content:'before'}],'p0');
 assert.equal(child.items[0].evidence[0].id,'c0');assert.equal(child.items[1].branchHold,true);assert.equal(child.undo.length,0);assert.equal(s.items[0].evidence[0].id,'p0');
 assert.ok((await inherit(s,[],[],'gone')).items.every(x=>x.branchHold));
 const r=await review(s,[]);assert.ok(r.items.every(x=>x.review));assert.equal(publicItems(r).length,0);
});
test('public label with character restriction still withholds; inherited edits need cut provenance',async()=>{
 const {inherit,fingerprint}=await import('../src/core.js');let s=empty();
 s=apply(s,{type:'put',confirmPublic:true,item:{id:'x',layer:'wiki',text:'restricted',scope:'public',knownBy:['foreign'],evidence:[]}});assert.equal(publicItems(s).length,0);
 const messages=[{id:'p',content:'before'}];s.items[0].evidence=[{id:'p',index:0,fingerprint:await fingerprint('before')}];
 assert.equal((await inherit(s,messages,[{id:'c',content:'before'}],'p')).items[0].branchHold,true);
});
