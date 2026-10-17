import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {setup} from '../src/frontend.js';
function mount(layer='promises',status='active'){
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);let listener;const sent=[];
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state:{version:1,revision:0,items:[{id:'p',layer,title:'새벽의 약속',text:'강가에서 만난다.',scope:'unknown',status,evidence:[]}],candidates:[],undo:[]}});
 return {root,sent,cleanup};
}
const click=(root,name)=>{const button=[...root.querySelectorAll('button')].find(x=>x.textContent===name);assert.ok(button,name);button.click();};
test('original seven-tab order, overview review queue and separate settings',()=>{
 const {root,cleanup}=mount();assert.deepEqual([...root.querySelectorAll('[data-tab]')].map(x=>x.dataset.tab),['overview','promises','flows','anchors','scenes','elements','wiki']);
 assert.ok(root.querySelector('.mmc-ov-grid'));assert.match(root.textContent,/검토 대기/);click(root,'설정');assert.ok(root.querySelector('[data-transfer]'));cleanup();
});
test('human editor keeps title, text, layer and explicit-public gate without raw IDs',()=>{
 const {root,sent,cleanup}=mount();click(root,'약속');click(root,'직접 추가');
 const title=root.querySelector('[aria-label="제목"]'),text=root.querySelector('[aria-label="내용"]');assert.ok(title);assert.ok(text);
 title.value='새 약속';text.value='<img src=x onerror=alert(1)> 안전한 글';
 click(root,'항목 저장');const request=sent.at(-1);assert.equal(request.type,'put');assert.equal(request.item.layer,'promises');assert.equal(request.item.title,'새 약속');assert.equal(request.item.scope,'unknown');assert.equal(request.confirmPublic,false);assert.equal(root.querySelectorAll('img').length,0);cleanup();
});
test('item detail shows text not executable HTML and edit preserves restrictions',()=>{
 const {root,sent,cleanup}=mount();click(root,'약속');click(root,'새벽의 약속');click(root,'편집');
 root.querySelector('[aria-label="내용"]').value='수정';click(root,'항목 저장');assert.equal(sent.at(-1).item.id,'p');assert.equal(sent.at(-1).item.scope,'unknown');cleanup();
});
test('only promises and flows have lifecycle filters, actions and editor state',()=>{
 for(const [layer,name] of [['promises','약속'],['flows','진행 흐름'],['anchors','기억 앵커'],['scenes','장면 기억'],['elements','요소 기억'],['wiki','이야기 위키']]){
  const {root,cleanup}=mount(layer);click(root,name);
  const lifecycle=['promises','flows'].includes(layer);
  assert.equal(root.textContent.includes('진행 중으로'),lifecycle,layer);
  assert.equal(root.textContent.includes('완료로'),lifecycle,layer);
  assert.equal(root.textContent.includes('진행 중'),lifecycle,layer);
  click(root,'편집');assert.equal(!!root.querySelector('[aria-label="상태"]'),lifecycle,layer);cleanup();
 }
});
test('legacy excluded wiki is identified and not silently reactivated on edit',()=>{
 const {root,sent,cleanup}=mount('wiki','completed');click(root,'이야기 위키');assert.match(root.textContent,/주입 제외/);click(root,'편집');
 click(root,'항목 저장');assert.equal(sent.at(-1).item.status,'completed');
 cleanup();
});
