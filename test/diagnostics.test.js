import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {diagnose,LONG_TEXT} from '../src/core.js';
import {setup} from '../src/frontend.js';
// Always-on diagnostics: computed in the panel, no model call, no backend request.
const m=(id,text,extra={})=>({id,layer:'anchors',text,scope:'public',status:'active',evidence:[],...extra});
const keyOf=rows=>Object.fromEntries(rows.map(r=>[r.key,r]));

test('duplicates, near duplicates, empty, long, undated, private, held, queue and auto error',()=>{
 const state={items:[
  m('d1','[1일차] 지아는 비를 싫어한다.'),m('d2','[2일차]  지아는 비를  싫어한다'),m('d3','[1일차] 지아는 비를 싫어한다',{layer:'promises'}),
  m('n1','[1일차] 민수는 파란 공책을 지아에게 빌려 주었다'),m('n2','[3일차] 민수는 파란 공책을 지아에게 빌려 주었고 돌려받았다'),
  m('e',''),m('l','[1일차] '+'가'.repeat(LONG_TEXT)),m('u','날짜 없는 기억'),
  m('p','[1일차] 비공개',{scope:'unknown'}),m('s','[1일차] 비밀',{scope:'secret'}),m('h','[1일차] 보류',{hold:true})
 ],candidates:[m('c','[1일차] 후보')]};
 const r=keyOf(diagnose(state,{last:{ok:false,error:'연결 실패'}}));
 assert.deepEqual(r.exact.ids.sort(),['d1','d2'],'same kind and same text after the date prefix');
 assert.deepEqual(r.near.ids.sort(),['n1','n2']);
 assert.deepEqual(r.empty.ids,['e']);assert.deepEqual(r.long.ids,['l']);assert.deepEqual(r.undated.ids,['u']);
 assert.deepEqual(r.private.ids,['p'],'unknown scope only; secret is a deliberate choice');assert.match(r.private.text,/주입되지 않는 기억 1개/);
 assert.deepEqual(r.held.ids,['h']);assert.match(r.pending.text,/검토 대기 후보 1개/);assert.match(r.auto.text,/연결 실패/);
 assert.deepEqual(diagnose({items:[m('ok','[1일차] 괜찮은 기억')],candidates:[]},{last:{ok:true}}),[]);
});

test('large lists stay fast (keyed, not pairwise)',()=>{
 const items=Array.from({length:2000},(_,i)=>m('i'+i,'[1일차] 서로 다른 기억 번호 '+i+' '+'다'.repeat(i%50)));
 const t=performance.now();diagnose({items,candidates:[]});assert.ok(performance.now()-t<500);
});

test('overview shows diagnostics without any backend request and links rows to their tab',()=>{
 const {document}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const root=document.createElement('div');document.body.append(root);const sent=[];let listener;
 const cleanup=setup({ui:{registerDrawerTab:()=>({root,destroy(){}})},sendToBackend:r=>sent.push(r),onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
 listener({requestId:sent[0].requestId,ok:true,chatId:'a',state:{revision:0,undo:[],items:[m('p','[1일차] 비공개 기억',{scope:'unknown',title:'비공개 기억'})],candidates:[]}});
 const n=sent.length,row=root.querySelector('[data-diag="private"]');assert.ok(row);assert.match(row.textContent,/비공개라 주입되지 않는 기억 1개/);
 [...row.querySelectorAll('button')].find(x=>x.textContent.includes('비공개 기억')).click();
 assert.equal(sent.length,n,'no request');assert.equal(root.querySelector('[data-tab="anchors"]').getAttribute('aria-current'),'page');
 assert.ok(root.querySelector('[data-promote="p"]'),'the memory opens with its make-public action');
 cleanup();
});
