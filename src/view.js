import {vaultStyle} from './vault-style.js';
import {publicItems,selectSafeCandidates,injectionText,MAX_INPUT_CHARS,MAX_RANGES,DEFAULT_RECENT,sourceSummary,localTimeZone} from './core.js';
const tabs=[['overview','개요'],['promises','약속'],['flows','진행 흐름'],['anchors','기억 앵커'],['scenes','장면 기억'],['elements','요소 기억'],['wiki','이야기 위키']];
const names=Object.fromEntries(tabs);
const hasLifecycle=layer=>['promises','flows'].includes(layer);
// Lists render at most PAGE rows at a time; "더 보기" adds another PAGE.
export const PAGE=20;
const clip=(s,n=60)=>{s=String(s??'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n-1)+'…':s;};
const theme=`
#mmc-root-v1{--mv-bg:var(--lumiverse-bg,#17151e);--mv-paper:var(--lumiverse-bg-elevated,#24212e);--mv-paper-2:var(--lumiverse-input-bg,#2b2738);--mv-sunk:var(--lumiverse-fill-subtle,#302c3e);--mv-ink:var(--lumiverse-text,#eee9f5);--mv-ink-2:var(--lumiverse-text,#ded8e8);--mv-muted:var(--lumiverse-text-muted,#a89fb9);--mv-line:var(--lumiverse-border,#40394f);--mv-line-2:var(--lumiverse-border,#51475f);--mv-accent:var(--lumiverse-primary,#a88bfa);--mv-accent-ink:var(--lumiverse-primary-deep-contrast,#fff);--mv-accent-soft:var(--lumiverse-primary-light,#39304f);--mv-accent-2:var(--lumiverse-primary-text,#c9a0cc);--mv-ok:var(--lumiverse-success,#73b69b);--mv-warn:#d2b275;--mv-danger:var(--lumiverse-danger,#ed8a9b);--mv-wiki-link:var(--mv-accent);--mv-wiki-head:var(--mv-accent);--mv-wiki-head-ink:var(--mv-accent-ink);--mv-wiki-box:var(--mv-paper-2);--mv-wiki-rule:var(--mv-line);color:var(--mv-ink);font-size:13px}
#mmc-root-v1 .mmc-overlay{position:relative;inset:auto;padding:0;background:none;backdrop-filter:none;display:block}
#mmc-root-v1 .mmc-shell{display:flex;flex-direction:column;width:100%;height:auto;min-height:0;max-height:none;border-radius:12px;box-shadow:none;overflow:visible}
#mmc-root-v1 .mmc-body{flex:none;overflow:visible;padding:12px;min-width:0;min-height:0;order:2}
#mmc-root-v1 .mmc-bar{flex-wrap:wrap;padding:14px;gap:8px}
#mmc-root-v1 .mmc-story{max-width:100%;margin:0;overflow:hidden}
#mmc-root-v1 .mmc-tabs{flex:none;flex-wrap:wrap;overflow:visible;padding:0 8px;gap:2px;order:1;grid-row:auto}
#mmc-root-v1 .mmc-tab{padding:0 10px;min-height:42px}
#mmc-root-v1 .mmc-tab-count{margin-left:5px;font-size:11px;color:var(--mv-muted)}
#mmc-root-v1 .mmc-tab[data-count]::after{content:attr(data-count);display:inline-grid;place-items:center;min-width:20px;height:20px;border-radius:999px;background:var(--mv-sunk);color:var(--mv-ink-2);font:700 11px/1 var(--mv-mono)}
#mmc-root-v1 .lv-stack{display:flex;flex-direction:column;gap:12px;min-width:0}
#mmc-root-v1 .lv-card{padding:16px;min-width:0}
#mmc-root-v1 .lv-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}
#mmc-root-v1 .lv-spacer{flex:1}
#mmc-root-v1 p{margin:6px 0 12px;line-height:1.65}
#mmc-root-v1 h3{font-size:16px;margin:0 0 10px}
#mmc-root-v1 pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:8px 0}
#mmc-root-v1 .lv-field{display:flex;flex-direction:column;gap:6px;margin:10px 0;min-width:0;font-weight:700}
#mmc-root-v1 input:not([type=checkbox]),#mmc-root-v1 select,#mmc-root-v1 textarea{width:100%;min-width:0;padding:9px 11px;color:var(--mv-ink);background:var(--mv-paper-2);border:1px solid var(--mv-line-2);border-radius:8px;font-size:13px}
#mmc-root-v1 textarea{min-height:120px;resize:vertical;font-weight:400}
#mmc-root-v1 .lv-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;font-weight:400;line-height:1.7}
#mmc-root-v1 .lv-check input{margin-top:5px;flex:none}
#mmc-root-v1 .lv-warning{padding:10px 12px;border-left:3px solid var(--mv-warn);background:var(--mv-paper-2);border-radius:6px;color:var(--mv-muted);font-size:12px}
#mmc-root-v1 .lv-notice{flex:none;order:4;color:var(--mv-muted);font-size:11px;padding:8px 14px;border-top:1px solid var(--mv-line)}
#mmc-root-v1 .lv-status{flex:none;order:5;position:sticky;bottom:0;z-index:2;padding:10px 14px;background:var(--mv-paper);border-top:1px solid var(--mv-line);font-size:12px;overflow-wrap:anywhere;margin:0}
#mmc-root-v1 .lv-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
#mmc-root-v1 .lv-chips .mmc-chip{min-height:32px;padding:0 10px;font-size:12px;cursor:pointer}
#mmc-root-v1 .lv-chips .mmc-chip.is-active{border-color:var(--mv-accent);background:var(--mv-accent-soft);color:var(--mv-ink)}
#mmc-root-v1 .lv-list{display:flex;flex-direction:column;gap:6px;min-width:0}
#mmc-root-v1 .lv-compact{padding:0}
#mmc-root-v1 .lv-line{display:flex;align-items:center;min-width:0;min-height:44px}
#mmc-root-v1 .lv-pick{display:grid;place-items:center;flex:none;width:44px;min-height:44px;cursor:pointer}
#mmc-root-v1 .lv-pick input{width:20px;height:20px;margin:0}
#mmc-root-v1 .lv-compact .lv-title{flex:1;min-width:0;min-height:44px;padding:0 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
#mmc-root-v1 .lv-pick+.lv-title{padding-left:0}
#mmc-root-v1 .lv-compact>small.lv-meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 12px 8px;margin-top:-6px;font-size:11px}
#mmc-root-v1 .lv-detail{padding:4px 12px 12px;border-top:1px solid var(--mv-line)}
#mmc-root-v1 .lv-more{width:100%;min-height:44px}
#mmc-root-v1 .lv-item{padding:12px;border:1px solid var(--mv-line);border-radius:10px;background:var(--mv-paper)}
#mmc-root-v1 .lv-item.is-selected{border-color:var(--mv-accent);background:var(--mv-accent-soft)}
#mmc-root-v1 .lv-title{display:block;text-align:left;width:100%;border:0;background:none;color:var(--mv-ink);font-weight:800;font-size:14px;padding:3px 0}
#mmc-root-v1 .lv-item small{display:block;color:var(--mv-muted);line-height:1.6;overflow-wrap:anywhere}
#mmc-root-v1 .lv-toolbar{margin-bottom:12px;display:flex;flex-wrap:wrap;gap:6px}
#mmc-root-v1 .lv-reader{line-height:1.85}
#mmc-root-v1 .lv-reader h2{border-bottom:2px solid var(--mv-accent);padding-bottom:12px;margin:4px 0 16px}
#mmc-root-v1 details{border:1px solid var(--mv-line);border-radius:8px;padding:10px;margin-top:12px}
#mmc-root-v1 summary{cursor:pointer;color:var(--mv-muted);font-weight:700}
#mmc-root-v1 .lv-scope{display:flex;flex-direction:column;gap:10px;margin:10px 0}
#mmc-root-v1 .lv-scope .mmc-seg{display:flex;gap:6px}
#mmc-root-v1 .lv-scope .mmc-seg .mmc-btn{flex:1;min-height:44px}
#mmc-root-v1 .lv-num{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:700}
#mmc-root-v1 .lv-scope input[inputmode=numeric]{width:6em;min-height:44px;font-size:16px;text-align:center}
#mmc-root-v1 .lv-ranges{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--mv-line);border-radius:10px}
#mmc-root-v1 .lv-range{display:flex;flex-wrap:nowrap;gap:6px;align-items:center}
#mmc-root-v1 .lv-range .lv-x{min-width:44px;min-height:44px}
#mmc-root-v1 .lv-add,#mmc-root-v1 .lv-run{width:100%;min-height:48px}
#mmc-root-v1 .lv-source-summary{font-weight:800;font-size:15px;margin:4px 0}
#mmc-root-v1 button:focus-visible,#mmc-root-v1 input:focus-visible,#mmc-root-v1 textarea:focus-visible,#mmc-root-v1 select:focus-visible{outline:2px solid var(--mv-accent);outline-offset:2px}
@container (max-width:650px){#mmc-root-v1 .mmc-ov-grid{grid-template-columns:minmax(0,1fr)}}
#mmc-root-v1{container-type:inline-size;max-width:100%;overflow-wrap:anywhere}
#mmc-root-v1 *{box-sizing:border-box;max-width:100%}
@media(max-width:700px){#mmc-root-v1 .mmc-tabs{order:1;justify-content:flex-start}#mmc-root-v1 .mmc-brand-text{display:flex}#mmc-root-v1 .mmc-brand-text small{display:none}}
@media(max-width:360px){#mmc-root-v1 .mmc-body{padding:10px}#mmc-root-v1 .mmc-brand-text b{font-size:16px}#mmc-root-v1 .mmc-tab{padding:0 8px}#mmc-root-v1 .mmc-ov-grid{grid-template-columns:minmax(0,1fr)}}
`;
export function createView(root,{send,get,ui}){
 const el=(tag,text,parent,cls)=>{const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;(parent||root).appendChild(x);return x;};
 const button=(text,fn,parent,cls='')=>{const b=el('button',text,parent,'mmc-btn '+cls);b.type='button';b.onclick=fn;return b;};
 const card=(parent,title)=>{const c=el('section',undefined,parent,'mmc-card lv-card');if(title)el('h3',title,c);return c;};
 const row=parent=>el('div',undefined,parent,'lv-row');
 const field=(label,tag,parent,value='')=>{const l=el('label',label,parent,'lv-field'),x=el(tag,undefined,l);x.setAttribute('aria-label',label);if(tag!=='select')x.value=value;return x;};
 const check=(label,parent,checked=false)=>{const l=el('label',undefined,parent,'lv-check'),x=el('input',undefined,l);x.type='checkbox';x.checked=checked;x.setAttribute('aria-label',label);el('span',label,l);return x;};
 const select=(label,options,parent,value)=>{const x=field(label,'select',parent);for(const [id,name] of options){const o=el('option',name,x);o.value=id;if(id===value)o.setAttribute('selected','');}return x;};
 // Entering the analysis view re-asks the message count (numbers only, no bodies) so a
 // chat that grew since the last visit is not blocked by a stale total.
 const go=tab=>{if(tab==='analysis')ui.countAsked=null;ui.tab=tab;ui.editor=null;ui.filter='all';ui.detail=null;ui.limits={};ui.queries={};render();};
 const title=x=>clip(x.title||x.text.split('\n')[0])||'제목 없는 기억';
 const matches=(x,q)=>!q||(title(x)+' '+x.text).toLowerCase().includes(q.toLowerCase());
 const explain=x=>[hasLifecycle(x.layer)?(x.status==='completed'?'완료':x.status==='cancelled'?'취소':'진행 중'):['completed','cancelled'].includes(x.status)?'주입 제외 (이전 상태)':'',x.scope==='public'?'공개':x.scope==='secret'?'비밀':x.scope==='character'?'인물 제한':'범위 확인 필요',x.hold?'보류':'',x.branchHold?'분기 보류':'',x.importedScope?'가져온 범위 보류':'',x.review?'근거 재검토':'',x.locked?'잠금':''].filter(Boolean).join(' · ');
 const openEditor=x=>{ui.editor={...(x||{id:crypto.randomUUID(),layer:ui.tab==='overview'?'promises':ui.tab,text:'',title:'',scope:'unknown',status:'active',source:'수동',evidence:[],knownBy:[]})};render();};
 // One page of rows plus a "더 보기" button; refills in place so search focus and scroll survive.
 function paged(parent,rows,key,draw,reveal){
  const list=el('div',undefined,parent,'lv-list');list.dataset.list=key;
  const fill=()=>{
   list.replaceChildren();let limit=ui.limits[key]||PAGE;
   const at=reveal?rows.findIndex(reveal):-1;if(at>=limit)limit=ui.limits[key]=Math.ceil((at+1)/PAGE)*PAGE;
   for(const x of rows.slice(0,limit))draw(x,list);
   const rest=rows.length-limit;
   if(rest>0){const more=button(`더 보기 (+${Math.min(PAGE,rest)}) · ${limit}/${rows.length}개 표시 중`,()=>{ui.limits[key]=limit+PAGE;fill();},list,'lv-more');more.dataset.more=key;}
  };
  fill();return list;
 }
 function searchable(parent,key,label,rows,draw,empty){
  const search=field(label,'input',parent,ui.queries[key]||'');search.type='search';
  const host=el('div',undefined,parent);
  const refresh=()=>{host.replaceChildren();const q=ui.queries[key]||'',hits=rows.filter(x=>matches(x,q));
   if(!hits.length){el('div',q?'검색 결과가 없어요.':empty,host,'mmc-empty mmc-card');return;}
   if(q)el('small','검색 결과 '+hits.length+'개',host,'mmc-muted');
   paged(host,hits,key,draw,x=>ui.detail===key+':'+x.id);
  };
  search.oninput=()=>{ui.queries[key]=search.value;ui.limits[key]=PAGE;refresh();};
  refresh();
 }
 function disclosure(parent){return check('공개 범위 확대 확인',parent);}
 function bulk(parent,state){
  const actions=row(parent);
  button('전체 선택',()=>{ui.selected=new Set([...state.items,...state.candidates].map(x=>x.id));render();},actions);
  button('안전 후보만 선택',()=>{ui.selected=new Set(selectSafeCandidates(state.candidates));render();},actions);
  button('선택 보류',()=>send('hold',{ids:[...ui.selected]}),actions);
  const confirm=disclosure(parent);
  button('선택 승인',()=>send('approve',{ids:[...ui.selected],confirmPublic:confirm.checked}),actions,'mmc-primary');
  button('선택 삭제',()=>send('delete',{ids:[...ui.selected]}),actions,'mmc-danger');
  el('small','선택 '+ui.selected.size+' · 후보 '+state.candidates.length,parent,'mmc-muted');
 }
 function overview(main,state){
  const safe=publicItems(state),review=state.items.filter(x=>x.review).length,held=state.items.filter(x=>x.hold||x.branchHold||x.importedScope).length;
  const chips=el('div',undefined,main,'lv-chips');chips.dataset.summary='true';
  for(const text of ['주입 '+safe.length,'후보 '+state.candidates.length,'재검토 '+review,'보류 '+held])el('span',text,chips,'mmc-chip');
  for(const [layer,name] of tabs.slice(1))button(name+' '+state.items.filter(x=>x.layer===layer).length,()=>go(layer),chips,'mmc-chip');
  const grid=el('div',undefined,main,'mmc-ov-grid');
  const injection=card(grid,'RP에 들어갈 공개 기억 '+safe.length+'개');
  el('p','답변할 때 승인한 공개 기억만 프롬프트에 넣습니다. 넣기 전에 매번 원문 근거를 다시 확인합니다.',injection);
  lastInjection(injection);autoLine(injection);
  button(ui.previewInjection?'주입 대상 접기':'주입 대상 보기',()=>{ui.previewInjection=!ui.previewInjection;render();},injection);
  if(ui.previewInjection){el('p','저장 상태 기준 후보입니다. 실제 답변에서는 원문 재검토·분기 검증 뒤 줄어들 수 있습니다.',injection,'lv-warning');paged(injection,safe,'inject',(x,list)=>itemRow(x,list,state,{slot:'inject',pick:false,layer:true}),x=>ui.detail==='inject:'+x.id);}
  const inbox=card(grid,'검토 대기');
  el('p',`새 후보 ${state.candidates.length}개 · 근거 재검토 ${review}개 · 보류 ${held}개`,inbox);
  bulk(inbox,state);
  const layers=el('div',undefined,inbox,'lv-chips'),pick=ui.queueLayer||'all';
  for(const [id,name] of [['all','전체'],...tabs.slice(1)]){const n=id==='all'?state.candidates.length:state.candidates.filter(x=>x.layer===id).length;if(id!=='all'&&!n)continue;const b=button(name+' '+n,()=>{ui.queueLayer=id;ui.limits.queue=PAGE;render();},layers,'mmc-chip'+(pick===id?' is-active':''));b.dataset.layer=id;}
  searchable(inbox,'queue','후보 검색',state.candidates.filter(x=>pick==='all'||x.layer===pick),(x,list)=>itemRow(x,list,state,{slot:'queue',candidate:true,layer:true}),'검토할 후보가 없어요.');
  const recent=card(main,'최근 변화');
  const changed=[...state.items].sort((a,b)=>(b.lastChangedAt||0)-(a.lastChangedAt||0)).slice(0,5);
  const list=el('div',undefined,recent,'lv-list');for(const x of changed)itemRow(x,list,state,{slot:'recent',pick:false,layer:true});
  if(!state.items.length)el('p','아직 보관된 기억이 없어요. 종류별 탭에서 직접 추가하거나 상단의 분석으로 후보를 만들어 보세요.',recent,'mmc-muted');
 }
 // Outcome of the most recent reply in this chat since the server started.
 function lastInjection(parent){
  const r=ui.injection,at=r&&Number.isFinite(r.at)?new Date(r.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'';
  const line=r?.status==='skipped'?el('p','최근 답변('+at+'): 기억을 넣지 못했습니다. 프롬프트에서 대화 기록의 출처를 확인할 수 없는 생성이었습니다(메시지를 하나로 합치는 프리셋, 대화 기록이 하나뿐인 이어쓰기 등).',parent,'lv-warning')
   :r?.status==='injected'?el('p','최근 답변('+at+'): 공개 기억 '+(r.count||0)+'개를 넣었습니다.',parent,'mmc-muted')
   :el('p','최근 답변: 서버 시작 뒤 이 채팅의 답변 기록이 아직 없습니다.',parent,'mmc-muted');
  line.dataset.injection=r?.status||'none';
 }
 // Automatic analysis status for this chat (off by default; nothing shown while off and unused).
 function autoLine(parent){
  const a=ui.auto;if(!a||(!a.enabled&&!a.last))return;
  const l=a.last,at=l?new Date(l.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'';
  const head='자동 분석'+(a.enabled?'':'(꺼짐)')+': ';
  const text=!l?head+'사용자 메시지 '+a.every+'개마다 · 아직 실행 전'
   :l.ok?head+'마지막 실행 '+at+' · 후보 '+l.added+'개'+(l.text?' · '+l.text:'')+(l.note?' · '+l.note:'')
   :head+'마지막 실행 '+at+' · 실패: '+l.error+(a.enabled?' · 사용자 메시지 '+a.every+'개가 더 쌓이면 다시 시도':'');
  const line=el('p',text,parent,l&&!l.ok?'lv-warning':'mmc-muted');line.dataset.auto=!l?'idle':l.ok?'ok':'error';
 }
 // Compact row: one clipped title line + one meta line. Only the tapped row renders its detail.
 function itemRow(x,parent,state,{slot='list',candidate=false,pick=true,layer=false}={}){
  const key=slot+':'+x.id,open=ui.detail===key;
  const article=el('article',undefined,parent,'lv-item lv-compact'+(open?' is-selected':''));article.dataset.id=x.id;
  const line=el('div',undefined,article,'lv-line');
  if(pick){const l=el('label',undefined,line,'lv-pick'),c=el('input',undefined,l);c.type='checkbox';c.checked=ui.selected.has(x.id);c.setAttribute('aria-label','선택: '+title(x));c.onchange=()=>c.checked?ui.selected.add(x.id):ui.selected.delete(x.id);}
  const t=button(title(x),()=>{ui.detail=open?null:key;render();},line,'lv-title');t.setAttribute('aria-expanded',String(open));
  el('small',[layer?names[x.layer]:'',explain(x),candidate?'승인 대기':''].filter(Boolean).join(' · '),article,'lv-meta');
  if(open)detail(x,article,state);
  return article;
 }
 function detail(x,parent,state){
  const c=el('div',undefined,parent,'lv-detail');
  const reader=el('div',undefined,c,'lv-reader');el('pre',x.text,reader);
  if(!state.candidates.includes(x)){
   if(hasLifecycle(x.layer)){
    const statuses=row(reader),confirm=disclosure(reader);
    for(const [value,label] of [['active','진행 중으로'],['completed','완료로'],['cancelled','취소로']])button(label,()=>send('put',{item:{...x,status:value},confirmPublic:confirm.checked}),statuses,'mmc-sm');
   }
   const how=el('details',undefined,reader);el('summary','RP에 이렇게 들어가요',how);el('pre',publicItems({items:[x]}).length?injectionText([x]):'현재는 주입하지 않는 기억입니다.',how);el('small','실제 답변에서는 원문·분기를 다시 검증합니다.',how,'mmc-muted');
  }
  if(x.targetId){el('h3','변경 전 → 변경 후',reader);el('pre',x.baseText||'(새 문서)',reader);el('pre',x.text,reader);}
  const actions=row(c);button('편집',()=>openEditor(x),actions);
  button('보류',()=>send('hold',{ids:[x.id]}),actions);button('삭제',()=>send('delete',{ids:[x.id]}),actions,'mmc-danger');
  if(x.layer==='wiki')button(x.locked?'잠금 해제':'잠금',()=>send(state.candidates.some(y=>y.id===x.id)?'editCandidate':'put',{item:{...x,locked:!x.locked}}),actions);
  const evidence=el('details',undefined,c);el('summary','근거 · 출처',evidence);el('p',x.source||'직접 추가',evidence);
  for(const e of x.evidence||[])el('p',`대화 ${Number.isInteger(e.index)?e.index+1:'?'} · ${e.fingerprint}`,evidence);
  if(!x.evidence?.length)el('p','연결된 원문 근거 없음',evidence);
  if(x.knownBy?.length)el('p','인물 제한이 있어 주입하지 않습니다. 인물 매핑은 아직 지원하지 않습니다.',evidence,'lv-warning');
 }
 function collection(main,state){
  const left=card(main);
  const bar=el('div',undefined,left,'lv-toolbar');button('직접 추가',()=>openEditor(),bar,'mmc-primary');button('원문에서 정리',()=>go('analysis'),bar);button('검토 대기',()=>go('overview'),bar);
  const filters=el('div',undefined,left,'mmc-seg');for(const [id,name] of hasLifecycle(ui.tab)?[['active','진행 중'],['hold','보류'],['done','완료'],['all','전체']]:[['hold','보류'],['all','전체']])button(name,()=>{ui.filter=id;ui.limits.list=PAGE;render();},filters,'mmc-filter'+(ui.filter===id?' is-active':''));
  const rows=[...state.items,...state.candidates].filter(x=>x.layer===ui.tab&&(ui.filter==='all'||ui.filter==='hold'&&(x.hold||x.branchHold||x.importedScope)||ui.filter==='done'&&['completed','cancelled'].includes(x.status)||ui.filter==='active'&&!x.hold&&x.status==='active'));
  el('small',names[ui.tab]+' '+rows.length+'개 · 눌러서 펼치기',left,'mmc-muted');
  searchable(left,'list','기억 검색',rows,(x,list)=>itemRow(x,list,state,{candidate:state.candidates.includes(x)}),'아직 이 종류의 기억이 없어요. 직접 추가하거나 원문에서 정리해 보세요.');
  if(ui.tab==='anchors')el('p','항상 기억할 공개 앵커만 지원합니다. 원작의 키워드 호출·주입 예산은 아직 지원하지 않습니다.',main,'lv-warning');
  if(ui.tab==='scenes'||ui.tab==='flows'||ui.tab==='elements'||ui.tab==='wiki')el('p','이 버전은 텍스트 중심 편집입니다. 원작의 구조화 장면·흐름별 이력·요소 검색 조건·위키 자동 갱신은 아직 지원하지 않습니다.',main,'lv-warning');
 }
 function editor(main,state){
  const draft=ui.editor,c=card(main,'기억 편집');
  const heading=row(c);button('목록으로',()=>{ui.editor=null;render();},heading,'mmc-ghost');
  const t=field('제목','input',c,draft.title||''),text=field('내용','textarea',c,draft.text);
  const layer=select('기억 종류',tabs.slice(1),c,draft.layer),scope=select('공개 범위',[['unknown','범위 확인 필요 (주입 안 함)'],['public','모두가 아는 기억'],['secret','비밀 (주입 안 함)'],['character','인물 제한 (주입 안 함)']],c,draft.scope);
  const status=hasLifecycle(draft.layer)?select('상태',[['active','진행 중'],['completed','완료'],['cancelled','취소']],c,draft.status||'active'):null;
  if(!status&&['completed','cancelled'].includes(draft.status))el('p','이전 상태로 주입 제외된 기억입니다. 편집해도 자동 재개하지 않습니다. 고급 JSON에서 상태를 검토하고 공개 범위 확대를 확인하세요.',c,'lv-warning');
  const update=()=>Object.assign(draft,{title:t.value,text:text.value,layer:layer.value,scope:scope.value,status:status?.value||draft.status||'active'});
  for(const input of [t,text,scope,status].filter(Boolean))input.oninput=update;
  layer.addEventListener('input',()=>{update();render();});
  const confirm=disclosure(c);el('p','기존 보류·근거·인물 제한은 편집만으로 해제하지 않습니다. 제한 해제는 고급 JSON에서 검토한 뒤 별도 확인해야 합니다.',c,'lv-warning');
  const save=()=>{update();send(state.candidates.some(x=>x.id===draft.id)?'editCandidate':'put',{item:{...draft},confirmPublic:confirm.checked});};
  button('항목 저장',save,c,'mmc-primary');
  if(draft.layer==='wiki')button('위키 diff 제안',()=>{update();const old=state.items.find(x=>x.id===draft.id);send('propose',{items:[{...draft,id:crypto.randomUUID(),targetId:old?.id,baseText:old?.text}]});},c);
  const advanced=el('details',undefined,c);el('summary','고급 JSON · 제한 검토',advanced);const raw=field('항목 JSON','textarea',advanced,JSON.stringify(draft,null,2));
  button('JSON 편집 적용',()=>{try{ui.editor=JSON.parse(raw.value);render();}catch{ui.note('JSON 형식 오류');}},advanced);
 }
 // Scope only: recent N or numeric ranges. The panel knows the chat's message count
 // and hidden positions, never message bodies; the service reads those on analyze.
 function analysis(main,chatId,state){
  const c=card(main,'원문 분석'),key=chatId||'',src=(ui.sourceByChat[key]||={scope:'last',n:String(DEFAULT_RECENT),ranges:[]}),count=ui.counts[key];
  if(chatId&&ui.countAsked!==key){ui.countAsked=key;send('count');}
  const box=el('div',undefined,c,'lv-scope'),seg=el('div',undefined,box,'mmc-seg');seg.setAttribute('role','group');seg.setAttribute('aria-label','분석 범위 방식');
  for(const [id,name] of [['last','최근'],['range','범위']]){const b=button(name,()=>{src.scope=id;if(id==='range'&&!src.ranges.length)src.ranges.push(defaultRange());render();},seg,'mmc-filter'+(src.scope===id?' is-active':''));b.dataset.scope=id;b.setAttribute('aria-pressed',String(src.scope===id));}
  const number=(parent,label,value,set)=>{const x=el('input',undefined,parent);x.type='text';x.setAttribute('inputmode','numeric');x.setAttribute('pattern','[0-9]*');x.setAttribute('aria-label',label);x.value=String(value??'');x.oninput=()=>{set(x.value.replace(/[^0-9]/g,''));update();};x.onchange=()=>{x.value=x.value.replace(/[^0-9]/g,'');};return x;};
  if(src.scope==='last'){const l=el('label',undefined,box,'lv-num');el('span','최근',l);number(l,'최근 메시지 개수',src.n,v=>src.n=v);el('span','개 메시지',l);}
  else{
   const list=el('div',undefined,box,'lv-ranges');
   for(const [k,r] of src.ranges.entries()){
    const line=el('div',undefined,list,'lv-range');line.dataset.range=String(k);
    number(line,'범위 '+(k+1)+' 시작',r.start,v=>r.start=v);el('span','–',line);number(line,'범위 '+(k+1)+' 끝',r.end,v=>r.end=v);
    button('×',()=>{src.ranges.splice(k,1);render();},line,'mmc-ghost lv-x').setAttribute('aria-label','범위 '+(k+1)+' 삭제');
   }
   if(src.ranges.length<MAX_RANGES)button('+ 범위 추가',()=>{src.ranges.push(defaultRange());render();},list,'lv-add');
  }
  const summary=el('p',undefined,c,'lv-source-summary'),warn=el('p',undefined,c,'lv-warning');
  const total=el('small',undefined,c,'mmc-muted');
  const profile=ui.connections.find(x=>x.id===ui.connection);
  const model=el('small',ui.connection?'모델: '+(profile?profile.name+' · '+(profile.model||'(모델 미지정)'):'선택한 연결')+' · '+(ui.mode||'raw'):'모델 연결이 아직 없습니다. 설정 탭에서 고르세요.',c,ui.connection?'mmc-muted':'lv-warning');model.dataset.model=ui.connection?'set':'none';
  const run=button(ui.analyzing?'분석 중…':'분석',()=>{
   const s=update();if(!s.ok){ui.note(s.error);return;}
   if(!ui.connection){ui.note('설정 탭에서 모델 연결을 먼저 고르세요.');go('settings');return;}
   ui.analyzing=true;run.disabled=true;run.textContent='분석 중…';
   send('analyze',{source:src.scope==='last'?{scope:'last',n:src.n}:{scope:'range',ranges:src.ranges.map(r=>({start:r.start,end:r.end}))},mode:ui.mode||'raw',connection:ui.connection,timeZone:localTimeZone()});
  },c,'mmc-primary lv-run');run.dataset.run='analyze';run.setAttribute('aria-label','분석 실행');
  el('small','누르면 고른 범위의 원문을 설정한 모델로 바로 보냅니다(한 번에 '+MAX_INPUT_CHARS.toLocaleString('en-US')+'자까지). 비밀이 담긴 대화는 범위에서 빼세요. 결과는 후보로만 들어가고 자동 승인하지 않습니다.',c,'mmc-muted');
  const queue=row(c);el('span','검토 대기 후보 '+state.candidates.length+'개',queue);button('검토 대기 열기',()=>go('overview'),queue,'mmc-sm');
  function update(){
   const s=!chatId?{ok:false,error:'채팅을 먼저 여세요.'}:count?sourceSummary(src.scope==='last'?{scope:'last',n:src.n}:{scope:'range',ranges:src.ranges},count.total,count.hidden):{ok:true,pending:true};
   summary.textContent=s.pending?'대화 개수 확인 중…':s.ok?s.text:'분석할 대화 없음';summary.dataset.sourceSummary=s.ok&&!s.pending?'ok':s.pending?'pending':'error';
   const notes=s.ok?(s.warnings||[]):[s.error];warn.textContent=notes.join(' ');warn.hidden=!notes.length;
   total.textContent=count?'전체 '+count.total+'개'+(count.hidden.length?' · 숨김 '+count.hidden.length+'개는 분석에서 빠집니다':'')+' · 번호는 채팅 순서 기준':'';
   run.disabled=!!ui.analyzing||(!s.ok&&!s.pending);
   return s.pending?{ok:true}:s;
  }
  const refresh=button('대화 개수 새로고침',()=>send('count'),c,'mmc-ghost mmc-sm');refresh.dataset.count='refresh';
  update();
 }
 const defaultRange=()=>{const t=ui.counts[get().chatId||'']?.total||0;return t?{start:String(Math.max(1,t-DEFAULT_RECENT+1)),end:String(t)}:{start:'1',end:String(DEFAULT_RECENT)};};
 function analysisSettings(main){
  const c=card(main,'분석 설정');
  if(!ui.connections.length&&!ui.connectionsAsked){ui.connectionsAsked=true;send('connections');}
  const mode=select('분석 모드',[['raw','직접 분석 (raw)'],['quiet','프리셋 적용 (quiet)']],c,ui.mode||'raw');mode.onchange=()=>ui.mode=mode.value;
  const connection=select('모델 연결',[['','연결을 선택하세요'],...ui.connections.map(x=>[x.id,x.name+' · '+(x.model||'(모델 미지정)')])],c,ui.connection||'');connection.onchange=()=>ui.connection=connection.value;
  button('모델 목록 새로고침',()=>send('connections'),c,'mmc-sm');
  el('p','분석 버튼을 누르면 고른 범위의 원문이 이 연결로 바로 전송됩니다. 비밀이 담긴 대화는 범위에서 빼세요. 모델 결과는 후보로만 들어가며 자동 승인하지 않습니다. 선택은 패널을 다시 불러오기 전까지 유지됩니다.',c,'lv-warning');
  autoSettings(main);
 }
 // Per-chat automatic analysis. Saved on the server apart from memories (no undo step).
 function autoSettings(main){
  const a=ui.auto||{enabled:false,every:10},c=card(main,'자동 분석');c.dataset.autoSettings='true';
  const toggle=check('사용자 메시지 N개마다 자동 분석',c,!!a.enabled);
  if(!a.enabled&&!ui.connection){toggle.disabled=true;el('small','켜려면 위에서 모델 연결을 먼저 고르세요.',c,'mmc-muted');}
  const l=el('label',undefined,c,'lv-num');el('span','사용자 메시지',l);const n=el('input',undefined,l);n.type='text';n.setAttribute('inputmode','numeric');n.setAttribute('pattern','[0-9]*');n.setAttribute('aria-label','자동 분석 간격');n.value=String(a.every||10);n.oninput=()=>{n.value=n.value.replace(/[^0-9]/g,'');};el('span','개마다 (3–100)',l);
  el('p','켜면 마지막 자동 분석 뒤의 대화 원문(한 번에 '+MAX_INPUT_CHARS.toLocaleString('en-US')+'자까지)이 위에서 고른 모델 연결로 자동 전송됩니다.',c,'lv-warning');
  const save=button('자동 분석 저장',()=>{
   const every=Number(n.value);
   if(!Number.isInteger(every)||every<3||every>100){ui.note('자동 분석 간격은 3~100 사이 정수로 입력하세요.');return;}
   if(toggle.checked&&!ui.connection){ui.note('자동 분석을 켜려면 모델 연결을 먼저 고르세요.');return;}
   send('autoSettings',{enabled:toggle.checked,every,mode:ui.mode||'raw',connection:ui.connection||'',timeZone:localTimeZone()});
  },c,'mmc-sm');save.dataset.autoSave='true';
  el('small',a.enabled?'켜짐 · 이 채팅만 · 사용자 메시지 '+a.every+'개마다 · 결과는 검토 대기 후보로만 들어갑니다':'꺼짐 (기본값) · 채팅마다 따로 켭니다. 켠 시점부터 셉니다.',c,'mmc-muted');
 }
 function settings(main,state){
  analysisSettings(main);
  const c=card(main,'설정 · 데이터 관리');const used=new TextEncoder().encode(JSON.stringify(state)).byteLength;
  el('p',`저장 용량 ${used.toLocaleString()} / 2,000,000바이트 · 되돌리기 최대 20회 (용량에 따라 감소)`,c);
  button(`되돌리기 (${state.undo?.length||0}회 가능)`,()=>send('undo'),c);button('근거 재검토',()=>send('review'),c);
  el('h3','내보내기 / 가져오기',c);el('p','JSON은 비밀을 포함할 수 있는 개인 백업입니다. 가져오기는 현재 항목을 교체하며 모두 주입 보류합니다. Marinara 원본 JSON 자동 변환은 지원하지 않습니다.',c,'lv-warning');
  const transfer=field('내보내기 가져오기 JSON','textarea',c,ui.transfer||'');transfer.dataset.transfer='true';transfer.oninput=()=>ui.transfer=transfer.value;
  button('JSON 내보내기',()=>send('export'),c);const confirm=check('현재 기억 교체 확인',c);
  button('JSON 가져오기 (현재 항목 교체·모두 보류)',()=>{if(!confirm.checked){ui.note('현재 기억 교체 확인이 필요합니다.');return;}try{send('import',{data:JSON.parse(transfer.value)});}catch{ui.note('JSON 형식 오류');}},c);
  const info=card(main,'이식 범위와 권한');el('p','Lumiverse 테마를 따릅니다. chats·chat_mutation은 소유권/원문 조회, generation은 사용자가 누른 분석과 켜 둔 자동 분석, interceptor는 생성 직전 기억 주입에 사용합니다. 메시지는 수정하지 않습니다.',info);
  el('p','인물 매핑·주입 예산·키워드 조건·흐름별 이력·구조화 장면·원본 데이터 변환·로어북 동기화·Keeper는 지원하지 않습니다. 가짜 설정은 표시하지 않습니다.',info,'lv-warning');
  el('p','영구 책을 만들지 않습니다. 과거 수동 내보내기 책은 호스트에서 직접 연결 해제·삭제하세요. 확장 비활성화는 데이터를 남깁니다. 제거 전 JSON을 내보내세요.',info);
 }
 function render(){
  // The drawer scrolls the whole panel; rebuild synchronously with no layout reads so its scroll position is kept.
  const {state,chatId,recovery}=get();root.replaceChildren();root.className='memory-cabinet';root.id='mmc-root-v1';el('style',vaultStyle+'\n'+theme);
  const overlay=el('div',undefined,root,'mmc-overlay'),shell=el('section',undefined,overlay,'mmc-shell');
  const bar=el('header',undefined,shell,'mmc-bar'),brand=el('div',undefined,bar,'mmc-brand');el('span','▤',brand,'mmc-brand-mark');const bt=el('span',undefined,brand,'mmc-brand-text');el('b','기억 보관함',bt);el('small','MEMORY VAULT · 0.2 BETA',bt);
  el('span',chatId?'현재 이야기 · 채팅별 보관함':'채팅을 여세요',bar,'mmc-story');
  const actions=el('div',undefined,bar,'mmc-head-actions');button('새로고침',()=>send('load'),actions,'mmc-sm');button('분석',()=>go('analysis'),actions,'mmc-sm');button('설정',()=>go('settings'),actions,'mmc-sm');
  const nav=el('nav',undefined,shell,'mmc-tabs');nav.setAttribute('aria-label','기억 종류');
  for(const [id,name] of tabs){const b=button(name,()=>go(id),nav,'mmc-tab'+(ui.tab===id?' is-active':''));b.dataset.tab=id;b.setAttribute('aria-label',name);b.setAttribute('aria-current',ui.tab===id?'page':'false');if(state&&id!=='overview'){b.dataset.count=state.items.filter(x=>x.layer===id).length;b.setAttribute('title',name+' '+b.dataset.count+'개');}}
  const main=el('main',undefined,shell,'mmc-body lv-stack');
  if(recovery){const c=card(main,'저장 데이터 복구');el('p','이전 데이터는 recovery.json에 보존합니다. 복원/초기화는 현재 기억을 교체하며 직전 백업은 유지합니다.',c);const confirm=check('복구 초기화 확인',c);button('직전 백업 복원',()=>send('restoreBackup',{confirmRecovery:confirm.checked}),c);button('기억 초기화',()=>send('reset',{confirmRecovery:confirm.checked}),c);}
  if(state){
   const used=new TextEncoder().encode(JSON.stringify(state)).byteLength;
   if(used>=1800000)el('p','용량 한도 근처: 오래된 되돌리기 이력은 저장 시 자동 정리됩니다. 현재 기억·후보 자체가 가득 차면 JSON 내보내기 후 불필요한 항목을 삭제하거나 텍스트를 줄이세요. 보류는 주입만 막습니다.',main,'lv-warning');
   if(ui.editor)editor(main,state);else if(ui.tab==='overview')overview(main,state);else if(ui.tab==='settings')settings(main,state);else if(ui.tab==='analysis')analysis(main,chatId,state);else collection(main,state);
  }else if(!recovery)el('p','채팅을 열고 새로고침해 주세요.',main,'mmc-empty');
  el('div','루미버스용 · 비공식. Lumiverse 팀이 제작·승인·보증·지원하는 확장이 아닙니다.',shell,'lv-notice');const status=el('p',ui.status||'',shell,'lv-status');status.setAttribute('role','status');
 }
 return {render};
}
