import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {setup} from '../src/frontend.js';
import {SCENE_DEFAULTS} from '../src/chronicle.js';
const state={version:1,revision:0,items:[],candidates:[],undo:[]};
const node=(id,start,end,extra={})=>({id,kind:'scene',label:'장면 '+start+'–'+end,title:'제목 '+id,body:'[이야기 1일차] 본문 '+id,keywords:['민수'],scope:'public',start,end,count:end-start+1,revision:1,tokens:20,state:'approved',reason:'',mode:'constant',parentId:'',children:[],entry:true,entryEdited:false,...extra});
const chronicle=(extra={})=>({revision:3,nodes:[node('n1',1,20)],candidates:[],settings:{...SCENE_DEFAULTS},book:{name:'기억 보관함 장면록 · abc123',attached:true},constantTokens:20,permission:true,lumibooks:false,branch:false,hidden:0,next:{start:'21',end:'40'},total:60,...extra});
function mount(){
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);const sent=[];let listener;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 const reply=(r,extra={})=>listener({requestId:r.requestId,ok:true,chatId:'a',state,...extra});
 const click=text=>{const b=[...root.querySelectorAll('button')].find(x=>x.textContent===text);assert.ok(b,'button '+text);b.click();};
 reply(sent[0]);
 // Model connection from the settings tab, then the scene tab.
 click('설정');reply(sent.find(x=>x.type==='connections'),{connections:[{id:'conn',name:'연결',model:'m'}]});
 const pick=root.querySelector('[aria-label="모델 연결"]');for(const o of pick.querySelectorAll('option'))o.toggleAttribute('selected',o.getAttribute('value')==='conn');pick.onchange();
 root.querySelector('[data-tab=scenes]').click();
 return {root,sent,reply,click,cleanup,last:type=>sent.filter(x=>x.type===type).at(-1)};
}
test('scene tab: opening asks the count and the chronicle; the suggested next range is pre-filled and one tap records it',()=>{
 const {root,sent,reply,click,cleanup,last}=mount();
 assert.ok(last('count'));assert.ok(last('sceneLoad'));
 reply(last('count'),{total:60,hidden:[25]});reply(last('sceneLoad'),{chronicle:chronicle()});
 assert.equal(root.querySelector('[aria-label="구간 1 시작"]').value,'21');assert.equal(root.querySelector('[aria-label="구간 1 끝"]').value,'40');
 assert.match(root.querySelector('[data-scene-summary]').textContent,/대화 21–40 \(20개, 숨김 1개 포함\)/);
 click('+ 구간 추가');assert.equal(root.querySelector('[aria-label="구간 2 시작"]').value,'41');assert.equal(root.querySelector('[aria-label="구간 2 끝"]').value,'60');
 click('기록하기');
 let r=last('sceneRecord');assert.deepEqual(r.source,{scope:'range',ranges:[{start:'21',end:'40'}]});assert.equal(r.connection,'conn');
 // Numbers only: no message text, IDs or digests leave the panel.
 assert.deepEqual(Object.keys(r).sort(),['chatId','connection','mode','requestId','revision','source','timeZone','type']);
 reply(r,{chronicle:chronicle({revision:4,candidates:[{...node('c1',21,40),replaces:''}]}),notice:'대화 21–40 장면 기록'});
 r=last('sceneRecord');assert.deepEqual(r.source.ranges,[{start:'41',end:'60'}],'the next range is sent after the first reply');
 reply(r,{chronicle:chronicle({revision:5,candidates:[node('c1',21,40),node('c2',41,60)],next:null})});
 assert.match(root.textContent,/2개 범위 중 2개 기록/);
 assert.equal(sent.filter(x=>x.type==='sceneRecord').length,2);
 cleanup();
});
test('scene tab: approve, keep private, merge pick and undo merge send the chronicle revision',()=>{
 const {root,reply,click,cleanup,last}=mount();
 reply(last('count'),{total:60,hidden:[]});
 reply(last('sceneLoad'),{chronicle:chronicle({nodes:[node('n1',1,20),node('n2',21,40,{mode:'keyword'}),{...node('ch',41,60),kind:'chapter',label:'장 41–60',children:['x1','x2']}],candidates:[node('c1',61,80)]})});
 click('승인 · 로어북에 쓰기');assert.deepEqual((({type,id,scope,confirmPublic,sceneRevision})=>({type,id,scope,confirmPublic,sceneRevision}))(last('sceneApprove')),{type:'sceneApprove',id:'c1',scope:'public',confirmPublic:true,sceneRevision:3});
 click('비공개로 보관');assert.equal(last('sceneApprove').scope,'unknown');assert.equal(last('sceneApprove').confirmPublic,undefined);
 for(const l of ['합치기 선택: 장면 1–20','합치기 선택: 장면 21–40']){const c=root.querySelector('[aria-label="'+l+'"]');c.checked=true;c.onchange();}
 click('고른 2개 합치기');assert.deepEqual(last('sceneMerge').ids,['n1','n2']);assert.equal(last('sceneMerge').connection,'conn');
 assert.match(root.textContent,/상시/);assert.match(root.textContent,/키워드/);
 [...root.querySelectorAll('button')].find(x=>x.textContent.startsWith('장 41–60')).click();
 click('합치기 취소');assert.equal(last('sceneUnmerge').id,'ch');
 cleanup();
});
test('scene tab: LumiBooks warning locks auto-hide; missing permission and branch notices; auto-hide off by default',()=>{
 const {root,reply,cleanup,last}=mount();
 reply(last('count'),{total:60,hidden:[]});
 reply(last('sceneLoad'),{chronicle:chronicle({lumibooks:true,permission:false})});
 assert.ok(root.querySelector('[data-scene-lumibooks]'));assert.ok(root.querySelector('[data-scene-permission]'));
 const hide=root.querySelector('[data-scene-hide]');assert.equal(hide.checked,false);assert.equal(hide.disabled,true);
 assert.equal(root.querySelector('[data-run=scene]').disabled,true,'recording needs the permission');
 cleanup();
});
