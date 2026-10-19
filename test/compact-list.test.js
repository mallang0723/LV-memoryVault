import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {setup} from '../src/frontend.js';
import {PAGE} from '../src/view.js';
// Phone use with hundreds of memories: lists stay compact, paged and searchable.
const pad=n=>String(n).padStart(3,'0');
const long=n=>'본문 '+pad(n)+' '+'아주 긴 내용이 이어집니다. '.repeat(20)+'끝표시'+pad(n);
function mount(state){
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);const sent=[];let listener;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state:{revision:0,undo:[],...state}});
 const buttons=()=>[...root.querySelectorAll('button')];
 const click=text=>{const b=buttons().find(x=>x.textContent===text);assert.ok(b,text);b.click();};
 const rows=()=>root.querySelectorAll('.lv-compact').length;
 const more=key=>root.querySelector(`[data-more="${key}"]`);
 const search=(label,value)=>{const x=root.querySelector(`[aria-label="${label}"]`);x.value=value;x.oninput();};
 return {root,sent,listener,click,rows,more,search,cleanup};
}
const items=n=>Array.from({length:n},(_,i)=>({id:'p'+i,layer:'promises',title:'약속 '+pad(i),text:long(i),scope:'public',status:'active',evidence:[]}));

test('300 memories render one compact page, grow by 20 and filter by search',()=>{
 const v=mount({items:items(300),candidates:[]});v.click('약속');
 assert.equal(v.rows(),PAGE);assert.equal(PAGE,20);
 assert.ok(!v.root.textContent.includes('끝표시000'),'collapsed rows must not render full text');
 assert.equal(v.root.querySelectorAll('.lv-detail').length,0);
 assert.match(v.more('list').textContent,/더 보기 \(\+20\) · 20\/300/);
 v.more('list').click();assert.equal(v.rows(),40);
 v.search('기억 검색','약속 299');assert.equal(v.rows(),1);assert.equal(v.more('list'),null);
 v.search('기억 검색','없는말');assert.equal(v.rows(),0);assert.match(v.root.textContent,/검색 결과가 없어요/);
 v.search('기억 검색','');assert.equal(v.rows(),PAGE);
 v.search('기억 검색','약속 299');v.click('진행 흐름');
 assert.equal(v.root.querySelector('[aria-label="기억 검색"]').value,'');assert.ok(!v.root.textContent.includes('검색 결과가 없어요'),'search does not leak across tabs');
 v.cleanup();
});

test('tapping a row expands only that row with full text and actions, tapping again folds it',()=>{
 const v=mount({items:items(300),candidates:[]});v.click('약속');
 v.click('약속 003');
 assert.equal(v.root.querySelectorAll('.lv-detail').length,1);assert.ok(v.root.textContent.includes('끝표시003'));
 assert.ok(v.root.querySelector('[aria-expanded="true"]'));
 v.click('편집');assert.equal(v.root.querySelector('[aria-label="제목"]').value,'약속 003');v.click('목록으로');
 v.click('약속 003');assert.equal(v.root.querySelectorAll('.lv-detail').length,0);
 v.click('약속 003');v.click('삭제');assert.deepEqual(v.sent.at(-1).ids,['p3']);
 v.cleanup();
});

test('overview: one-line summary chips, paged review queue with layer and text filters',()=>{
 const candidates=[...items(250).map(x=>({...x,id:'c'+x.id})),...Array.from({length:50},(_,i)=>({id:'w'+i,layer:'wiki',title:'위키 '+pad(i),text:long(i),scope:'unknown',evidence:[]}))];
 const v=mount({items:items(300),candidates});
 const chips=v.root.querySelector('[data-summary]');assert.ok(chips);assert.match(chips.textContent,/주입 300/);assert.match(chips.textContent,/후보 300/);
 assert.equal(v.root.querySelectorAll('.lv-stat').length,0);
 const queue=()=>v.root.querySelectorAll('[data-list="queue"] .lv-compact').length;
 assert.equal(queue(),PAGE);assert.ok(v.rows()<=PAGE+5,'overview total rows stay small: '+v.rows());
 v.more('queue').click();assert.equal(queue(),40);
 v.root.querySelector('[data-layer="wiki"]').click();assert.equal(queue(),PAGE);assert.match(v.more('queue').textContent,/20\/50/);
 v.search('후보 검색','위키 049');assert.equal(queue(),1);
 v.root.querySelector('[aria-label="선택: 위키 049"]').checked=true;v.root.querySelector('[aria-label="선택: 위키 049"]').onchange();
 v.root.querySelector('[aria-label="공개 범위 확대 확인"]').checked=true;v.click('선택 승인');
 assert.deepEqual(v.sent.at(-1).ids,['w49']);assert.equal(v.sent.at(-1).confirmPublic,true);
 v.click('위키 049');assert.ok(v.root.textContent.includes('끝표시049'));
 v.click('주입 대상 보기');assert.equal(v.root.querySelectorAll('[data-list="inject"] .lv-compact').length,PAGE);
 v.cleanup();
});

test('source picker renders the latest 20 messages, pages backward and still selects all',()=>{
 const v=mount({items:[],candidates:[]});
 v.click('약속');v.click('원문에서 정리');v.click('원문 목록 읽기');
 const messages=Array.from({length:300},(_,i)=>({id:'m'+i,content:'메시지 '+i,index:i}));
 v.listener({requestId:v.sent.at(-1).requestId,ok:true,chatId:'a',state:{revision:0,items:[],candidates:[],undo:[]},messages,total:300});
 v.click('대화 목록 펼치기');
 const labels=()=>[...v.root.querySelectorAll('.lv-source b')].map(x=>x.textContent);
 assert.equal(labels().length,PAGE);assert.equal(labels()[0],'대화 281');assert.equal(labels().at(-1),'대화 300');
 assert.match(v.root.textContent,/보이지 않는 대화에도 적용/);
 v.more('sources').click();assert.equal(labels().length,40);assert.equal(labels()[0],'대화 261');
 v.click('전체 선택');assert.equal(v.root.querySelector('[data-selected]').dataset.selected,'300');
 v.cleanup();
});

test('panel uses one scroll: no fixed-height shell or scrolling body box',()=>{
 const v=mount({items:[],candidates:[]});const css=v.root.querySelector('style').textContent;
 const theme=css.slice(css.lastIndexOf('#mmc-root-v1{--mv-bg'));
 assert.ok(!theme.includes('calc(100dvh - 160px)'));
 assert.match(theme,/\.mmc-shell\{[^}]*height:auto[^}]*overflow:visible/);
 assert.match(theme,/\.mmc-body\{[^}]*overflow:visible/);
 assert.ok(!/\.mmc-tabs\{order:3/.test(theme),'tabs stay on top on phones');
 v.cleanup();
});
