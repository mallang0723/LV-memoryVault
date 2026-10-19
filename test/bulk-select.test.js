import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {setup} from '../src/frontend.js';
// Per-tab select-all / clear / hold / delete, review-queue select-all without risky
// candidates, and delete behind the host confirmation dialog.
const pad=n=>String(n).padStart(3,'0');
function mount(state,answer=true){
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);const sent=[],asked=[];let listener;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}}),showConfirm:async o=>{asked.push(o);return {confirmed:answer};}},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state:{revision:0,undo:[],...state}});
 const buttons=()=>[...root.querySelectorAll('button')];
 const click=text=>{const b=buttons().find(x=>x.textContent===text);assert.ok(b,text);b.click();};
 const checked=()=>[...root.querySelectorAll('.lv-pick input')].filter(x=>x.checked).length;
 const search=(label,value)=>{const x=root.querySelector(`[aria-label="${label}"]`);x.value=value;x.oninput();};
 return {root,sent,asked,listener,click,checked,search,buttons,cleanup};
}
const tick=()=>new Promise(r=>setTimeout(r,0));
const promise=i=>({id:'p'+i,layer:'promises',title:'약속 '+pad(i),text:'[1일차] 본문 '+i,scope:'public',status:'active',evidence:[]});
const anchor=i=>({id:'a'+i,layer:'anchors',title:'앵커 '+pad(i),text:'[1일차] 앵커 '+i,scope:'public',evidence:[]});

test('tab select-all covers the filtered and searched rows of that tab only, on every page',async()=>{
 const v=mount({items:[...Array.from({length:30},(_,i)=>promise(i)),anchor(1)],candidates:[]});
 v.click('약속');
 assert.ok(v.buttons().some(x=>x.textContent==='전체 선택 (30개)'));
 v.search('기억 검색','약속 00');
 const all=v.root.querySelector('[data-select-all="list"]');assert.equal(all.textContent,'전체 선택 (10개)','label follows the search');
 all.click();assert.equal(v.checked(),10);assert.match(v.root.querySelector('[data-selected-count]').textContent,/선택 10개/);
 v.click('선택 삭제');await tick();
 assert.equal(v.asked.length,1);assert.match(v.asked[0].message,/약속 10개를 삭제/);assert.match(v.asked[0].message,/되돌리기/);assert.equal(v.asked[0].variant,'danger');
 const del=v.sent.at(-1);assert.equal(del.type,'delete');assert.deepEqual(del.ids.sort(),Array.from({length:10},(_,i)=>'p'+i).sort());
 v.cleanup();
});

test('cancelled delete sends nothing; switching tabs clears the selection; clear button works',async()=>{
 const v=mount({items:[...Array.from({length:3},(_,i)=>promise(i)),anchor(1)],candidates:[]},false);
 v.click('약속');v.click('전체 선택 (3개)');assert.equal(v.checked(),3);
 const before=v.sent.length;v.click('선택 삭제');await tick();assert.equal(v.sent.length,before,'cancelled');assert.equal(v.asked.length,1);
 v.click('선택 해제');assert.equal(v.checked(),0);
 v.click('전체 선택 (3개)');v.click('기억 앵커');assert.equal(v.checked(),0);
 v.click('선택 삭제');await tick();assert.equal(v.asked.length,1,'nothing selected: no dialog');assert.equal(v.sent.length,before);
 v.click('약속');v.click('전체 선택 (3개)');v.click('선택 보류');assert.equal(v.sent.at(-1).type,'hold');assert.equal(v.sent.at(-1).ids.length,3);
 v.cleanup();
});

test('overview select-all picks only visible queue candidates, never saved memories, and skips risky ones with a notice',()=>{
 const cand=(id,extra={})=>({id,layer:'promises',title:'후보 '+id,text:'[1일차] '+id,scope:'unknown',evidence:[],...extra});
 const v=mount({items:[promise(1)],candidates:[cand('c1'),cand('c2'),cand('wiki',{layer:'wiki',targetId:'w',baseText:'old'}),cand('held',{hold:true}),cand('anc',{layer:'anchors'})]});
 const all=v.root.querySelector('[data-select-all="queue"]');assert.equal(all.textContent,'전체 선택 (위험 후보 제외)');
 all.click();assert.equal(v.checked(),3);assert.match(v.root.querySelector('[role=status]').textContent,/3개 선택 · 직접 확인이 필요한 후보 2개/);
 v.click('선택 승인');const r=v.sent.at(-1);
 assert.deepEqual([r.type,r.scope,r.confirmPublic],['approve','public',true]);assert.deepEqual(r.ids.sort(),['anc','c1','c2']);
 v.root.querySelector('[data-layer="anchors"]').click();v.root.querySelector('[data-select-all="queue"]').click();assert.equal(v.checked(),1);
 v.root.querySelector('[data-layer="all"]').click();v.search('후보 검색','c2');v.root.querySelector('[data-select-all="queue"]').click();assert.equal(v.checked(),1);
 v.cleanup();
});

test('risky candidates picked by hand are left out of bulk approval with a notice',()=>{
 const v=mount({items:[],candidates:[{id:'ok',layer:'promises',title:'괜찮은 후보',text:'a',scope:'unknown',evidence:[]},{id:'rv',layer:'promises',title:'재검토 후보',text:'b',scope:'unknown',review:true,evidence:[]}]});
 for(const label of ['선택: 괜찮은 후보','선택: 재검토 후보']){const c=v.root.querySelector(`[aria-label="${label}"]`);c.checked=true;c.onchange();}
 assert.match(v.root.querySelector('[data-selected-count]').textContent,/선택 2개/);
 v.click('선택 승인');assert.deepEqual(v.sent.at(-1).ids,['ok']);assert.match(v.root.querySelector('[role=status]').textContent,/직접 확인이 필요한 후보 1개는 빼고/);
 const c=v.root.querySelector('[aria-label="선택: 재검토 후보"]');c.checked=true;c.onchange();
 const n=v.sent.length;v.click('선택 비공개로 보관');assert.equal(v.sent.length,n,'only risky selected: nothing sent');
 v.cleanup();
});

test('queue delete asks first; candidate detail approves in one tap; private memory can be made public',async()=>{
 const v=mount({items:[{id:'priv',layer:'anchors',title:'비공개 앵커',text:'[1일차] 비공개',scope:'unknown',evidence:[]}],candidates:[{id:'c',layer:'promises',title:'후보 하나',text:'[1일차] 후보',scope:'unknown',evidence:[]},{id:'s',layer:'promises',title:'비밀 후보',text:'[1일차] 비밀',scope:'secret',evidence:[]}]});
 assert.ok(v.root.querySelector('[data-approve-hint]'),'queue says approved items go into the prompt');
 const c=v.root.querySelector('[aria-label="선택: 후보 하나"]');c.checked=true;c.onchange();v.click('선택 삭제');await tick();
 assert.match(v.asked[0].message,/검토 대기 후보 1개를 삭제/);assert.deepEqual(v.sent.at(-1),{...v.sent.at(-1),type:'delete',ids:['c']});
 v.click('후보 하나');v.click('승인 · 프롬프트에 넣기');assert.deepEqual([v.sent.at(-1).type,v.sent.at(-1).ids,v.sent.at(-1).scope,v.sent.at(-1).confirmPublic],['approve',['c'],'public',true]);
 v.click('후보 하나');v.click('비밀 후보');
 assert.ok(!v.buttons().some(x=>x.textContent==='승인 · 프롬프트에 넣기'),'no public approval for a secret candidate');
 v.click('승인 (범위 유지·주입 안 함)');assert.equal(v.sent.at(-1).scope,'unknown');
 v.click('기억 앵커');v.click('비공개 앵커');v.click('모두가 아는 기억으로 (주입)');
 const put=v.sent.at(-1);assert.deepEqual([put.type,put.item.scope,put.confirmPublic],['put','public',true]);
 v.cleanup();
});
