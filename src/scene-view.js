import {MAX_RANGES,MAX_INPUT_CHARS,sourceSummary,resolveScope,nextRange,spanLabel,localTimeZone,strictInt} from './core.js';
import {SCENE_LIMITS,SCENE_BOOK_PREFIX} from './chronicle.js';
// 장면록 section of the 장면 기억 tab. The panel holds the message count and hidden
// positions only; recording sends numbers, and the service reads the messages.
const SCENE_MODE_NAMES={constant:'상시',keyword:'키워드',off:'꺼짐',none:''};
const SCENE_STATE_NAMES={stale:'갱신 필요 (원문 또는 하위 장면이 바뀜)',held:'보류',archived:'보관 (장에 합쳐짐)',undone:'합치기 취소됨'};
const SCENE_SCOPE_NAMES={public:'공개',unknown:'비공개 (로어북에 안 씀)',secret:'비밀 (로어북에 안 씀)',character:'인물 제한 (로어북에 안 씀)'};
export function createSceneView({el,button,card,field,check,send,get,ui,confirm,rerender}){
 const sceneSend=(type,extra={},after)=>send(type,{...extra,...(ui.chronicle?{sceneRevision:ui.chronicle.revision}:{})},{scene:true,after});
 const short=(s,n=40)=>{s=String(s??'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n-1)+'…':s;};
 const number=(parent,label,value,set,onInput)=>{const x=el('input',undefined,parent);x.type='text';x.setAttribute('inputmode','numeric');x.setAttribute('pattern','[0-9]*');x.setAttribute('aria-label',label);x.value=String(value??'');x.oninput=()=>{set(x.value);onInput?.();};x.onchange=x.oninput;return x;};
 const model=()=>({mode:ui.mode||'raw',connection:ui.connection,timeZone:localTimeZone()});
 // Ranges per chat, pre-filled from the service's suggestion (right after the last
 // recorded message, same length) until the user edits them.
 const rangesFor=(chatId,c)=>{const box=(ui.sceneRanges||={});if(!box[chatId]||(!box[chatId].touched&&c?.next&&box[chatId].from!==c.revision+':'+c.total))box[chatId]={touched:false,from:c?c.revision+':'+c.total:'',rows:c?.next?[{...c.next}]:[{start:'1',end:'20'}]};return box[chatId];};
 const sceneStep=reply=>{
  const b=ui.sceneBatch;if(!b)return false;
  const label=spanLabel([b.spans[b.index]]);
  if(reply.ok)b.ok.push(label);else b.fail.push(label+' – '+String(reply.error||'알 수 없는 오류'));
  b.index++;
  if(b.index<b.spans.length){sendSpan(b);return true;}
  ui.sceneBatch=null;
  const box=ui.sceneRanges?.[get().chatId||''];if(box&&b.ok.length)box.touched=false;
  ui.status=(b.spans.length>1?b.spans.length+'개 범위 중 '+b.ok.length+'개 기록':b.ok.length?(reply.notice||'기록 완료'):'')+(b.fail.length?(b.spans.length>1?', 실패: ':'기록 실패: ')+b.fail.join(' / '):'')+(b.ok.length&&b.spans.length>1?' · 검토 대기에서 확인 후 승인하세요':'');
  return true;
 };
 const sendSpan=b=>{const [a,z]=b.spans[b.index];ui.status=(b.spans.length>1?'범위 '+(b.index+1)+'/'+b.spans.length+' ':'')+spanLabel([[a,z]])+' 기록 중…';send('sceneRecord',{source:{scope:'range',ranges:[{start:String(a),end:String(z)}]},...b.opts},{scene:true,after:sceneStep});};
 function recorder(parent,chatId,c){
  const box=rangesFor(chatId,c),count=ui.counts?.[chatId];
  const wrap=el('div',undefined,parent,'lv-scope');wrap.dataset.sceneRecord='true';
  const list=el('div',undefined,wrap,'lv-ranges');
  let add=null,addHint=null;
  for(const [k,r] of box.rows.entries()){
   const line=el('div',undefined,list,'lv-range');line.dataset.sceneRange=String(k);
   number(line,'구간 '+(k+1)+' 시작',r.start,v=>{r.start=v;box.touched=true;},update);el('span','–',line);number(line,'구간 '+(k+1)+' 끝',r.end,v=>{r.end=v;box.touched=true;},update);
   if(box.rows.length>1)button('×',()=>{box.rows.splice(k,1);box.touched=true;rerender();},line,'mmc-ghost lv-x').setAttribute('aria-label','구간 '+(k+1)+' 삭제');
  }
  if(box.rows.length<MAX_RANGES){add=button('+ 구간 추가',()=>{const n=nextRange(box.rows.at(-1),count?.total);if(!n||ui.sceneBatch)return;box.rows.push(n);box.touched=true;rerender();},list,'lv-add');add.dataset.sceneAdd='true';addHint=el('small',undefined,list,'mmc-muted');}
  const summary=el('p',undefined,wrap,'lv-source-summary'),warn=el('p',undefined,wrap,'lv-warning');
  const run=button(ui.sceneBatch?'기록 중…':'기록하기',()=>{
   if(ui.sceneBatch)return;const s=update();if(!s.ok){ui.note(s.error);return;}
   if(!ui.connection){ui.note('설정 탭에서 모델 연결을 먼저 고르세요.');return;}
   ui.sceneBatch={spans:s.spans,index:0,ok:[],fail:[],opts:model()};run.disabled=true;run.textContent='기록 중…';sendSpan(ui.sceneBatch);ui.note(ui.status);
  },wrap,'mmc-primary lv-run');run.dataset.run='scene';run.setAttribute('aria-label','장면 기록하기');
  el('small','누르면 구간마다 원문(숨김 메시지 포함, 구간당 '+MAX_INPUT_CHARS.toLocaleString('en-US')+'자까지)을 설정 탭의 모델 연결로 한 번씩 보내 장면 후보를 만듭니다. 자동 재시도는 없습니다. 같은 응답의 약속·진행 흐름은 기억 검토 대기 후보로 들어갑니다. 승인 전에는 아무것도 주입하지 않습니다.',wrap,'mmc-muted');
  function update(){
   const scope={scope:'range',ranges:box.rows};
   const s=!count?resolveScope(scope,Number.MAX_SAFE_INTEGER):sourceSummary(scope,count.total,count.hidden);
   summary.textContent=!count?(s.ok?'대화 개수 확인 중…':'기록할 수 없는 구간'):s.ok?s.text:'기록할 수 없는 구간';summary.dataset.sceneSummary=s.ok&&count?'ok':s.ok?'pending':'error';
   const notes=s.ok?(s.warnings||[]):[s.error];warn.textContent=notes.join(' ');warn.hidden=!notes.length;
   run.disabled=!!ui.sceneBatch||!s.ok||!c?.permission;
   if(add){const n=nextRange(box.rows.at(-1),count?.total);add.disabled=!!ui.sceneBatch||!n;addHint.textContent=!n&&count?'마지막 구간이 대화 끝('+count.total+')까지라 이어서 추가할 구간이 없습니다.':'';addHint.hidden=!addHint.textContent;}
   return s;
  }
  update();
 }
 function editor(parent,x,candidate){
  const d=ui.sceneEdit,c=el('div',undefined,parent,'lv-detail');c.dataset.sceneEditor=x.id;
  const t=field('제목 (목록에만 보임)','input',c,d.title),b=field('본문 (로어북에 이 글만 들어갑니다)','textarea',c,d.body),k=field('키워드 (쉼표로 구분, 조사 없이)','input',c,d.keywords);
  const scopes=candidate?[['unknown',SCENE_SCOPE_NAMES.unknown],['secret',SCENE_SCOPE_NAMES.secret]]:[['public','공개 (로어북에 씀)'],['unknown',SCENE_SCOPE_NAMES.unknown],['secret',SCENE_SCOPE_NAMES.secret]];
  const sc=field('공개 범위','select',c);for(const [id,name] of scopes){const o=el('option',name,sc);o.value=id;if(id===d.scope)o.setAttribute('selected','');}
  const ok=candidate?null:check('공개 범위 확대 확인',c);
  for(const [input,key] of [[t,'title'],[b,'body'],[k,'keywords'],[sc,'scope']])input.oninput=()=>{d[key]=input.value;};sc.onchange=sc.oninput;
  el('small','본문은 "[이야기 3일차 밤]"처럼 날짜로 시작하고, 제목·머리말·채팅 이름은 넣지 마세요.',c,'mmc-muted');
  const actions=el('div',undefined,c,'lv-actions');
  button('저장',()=>sceneSend('sceneEdit',{id:x.id,title:d.title,body:d.body,keywords:d.keywords,scope:d.scope,...(ok?.checked?{confirmPublic:true}:{})},reply=>{if(reply.ok)ui.sceneEdit=null;return false;}),actions,'mmc-primary').dataset.sceneSave=x.id;
  button('취소',()=>{ui.sceneEdit=null;rerender();},actions);
 }
 const openEdit=x=>{ui.sceneEdit={id:x.id,title:x.title||'',body:x.body,keywords:x.keywords.join(', '),scope:x.scope};rerender();};
 function candidates(parent,c){
  const box=card(parent,'장면 검토 대기 '+c.candidates.length+'개');box.dataset.sceneQueue='true';
  if(!c.candidates.length){el('p','검토할 장면 후보가 없어요. 위에서 구간을 기록하세요.',box,'mmc-muted');return;}
  el('p','‘승인’하면 이 채팅 전용 로어북에 본문만 들어가 다음 답변부터 쓰입니다. ‘비공개로 보관’은 보관함에만 두고 로어북에 쓰지 않습니다.',box,'lv-hint');
  for(const x of c.candidates){
   const a=el('article',undefined,box,'lv-item');a.dataset.sceneCandidate=x.id;
   el('b',x.label+(x.title?' 「'+short(x.title,30)+'」':'')+(x.replaces?' · 다시 기록':''),a);
   el('small',['본문 '+x.body.length+'자 · ≈'+x.tokens+'토큰',x.keywords.length?'키워드: '+x.keywords.join(', '):'키워드 없음',x.scope!=='unknown'?SCENE_SCOPE_NAMES[x.scope]:''].filter(Boolean).join(' · '),a,'mmc-muted');
   if(ui.sceneEdit?.id===x.id){editor(a,x,true);continue;}
   el('pre',x.body,a);
   const act=el('div',undefined,a,'lv-actions');
   if(!['secret','character'].includes(x.scope))button('승인 · 로어북에 쓰기',()=>sceneSend('sceneApprove',{id:x.id,scope:'public',confirmPublic:true}),act,'mmc-primary').dataset.sceneApprove='public';
   button(['secret','character'].includes(x.scope)?'승인 (로어북에 안 씀)':'비공개로 보관',()=>sceneSend('sceneApprove',{id:x.id,scope:'unknown'}),act).dataset.sceneApprove='unknown';
   button('고치기',()=>openEdit(x),act);
   button('버리기',()=>sceneSend('sceneDiscard',{id:x.id}),act,'mmc-danger');
  }
 }
 const badge=x=>[x.state==='approved'?(x.scope==='public'?SCENE_MODE_NAMES[x.mode]||'꺼짐':SCENE_SCOPE_NAMES[x.scope]):SCENE_STATE_NAMES[x.state]||x.state,x.entryEdited?'로어북에서 바뀜':''].filter(Boolean).join(' · ');
 function records(parent,c,chatId){
  const box=card(parent,'장면록');box.dataset.sceneList='true';
  const frontier=c.nodes.filter(x=>!['archived','undone'].includes(x.state)).sort((a,b)=>a.start-b.start);
  if(!frontier.length){el('p','승인한 장면이 아직 없어요.',box,'mmc-muted');return;}
  const picked=(ui.sceneSelected||=new Set());for(const id of [...picked])if(!frontier.some(x=>x.id===id))picked.delete(id);
  const mergeBar=el('div',undefined,box,'lv-bulk');
  const merge=button('',()=>{
   const ids=frontier.filter(x=>picked.has(x.id)).map(x=>x.id);if(ids.length<2){ui.note('이어진 장면을 두 개 이상 고르세요.');return;}
   if(!ui.connection){ui.note('설정 탭에서 모델 연결을 먼저 고르세요.');return;}
   merge.disabled=true;sceneSend('sceneMerge',{ids,...model()},reply=>{if(reply.ok)picked.clear();return false;});ui.note('합치는 중…');
  },mergeBar,'mmc-primary');merge.dataset.sceneMerge='true';
  const relabel=()=>{merge.textContent='고른 '+picked.size+'개 합치기';merge.disabled=picked.size<2;};relabel();
  el('small','이웃한 장면·장을 골라 하나의 장으로 합칩니다(모델 호출 1회, 승인 전에는 원래 장면이 그대로 들어감).',mergeBar,'mmc-muted');
  for(const x of frontier){
   const a=el('article',undefined,box,'lv-item lv-compact'+(ui.sceneOpen===x.id?' is-selected':''));a.dataset.sceneNode=x.id;
   const line=el('div',undefined,a,'lv-line'),l=el('label',undefined,line,'lv-pick'),cb=el('input',undefined,l);
   cb.type='checkbox';cb.checked=picked.has(x.id);cb.setAttribute('aria-label','합치기 선택: '+x.label);cb.onchange=()=>{cb.checked?picked.add(x.id):picked.delete(x.id);relabel();};
   const t=button(x.label+(x.title?' 「'+short(x.title,24)+'」':''),()=>{ui.sceneOpen=ui.sceneOpen===x.id?null:x.id;rerender();},line,'lv-title');t.setAttribute('aria-expanded',String(ui.sceneOpen===x.id));
   el('small',badge(x)+' · ≈'+x.tokens+'토큰',a,'lv-meta').dataset.sceneBadge=x.mode;
   if(ui.sceneOpen!==x.id)continue;
   if(ui.sceneEdit?.id===x.id){editor(a,x,false);continue;}
   const d=el('div',undefined,a,'lv-detail');el('pre',x.body,d);
   el('small',(x.keywords.length?'키워드: '+x.keywords.join(', '):'키워드 없음 (상시가 아니면 주입되지 않음)'),d,'mmc-muted');
   if(x.kind==='chapter'){const kids=c.nodes.filter(y=>x.children.includes(y.id)).map(y=>y.label);el('small','보관된 장면: '+kids.join(', ')+' (주입 안 함)',d,'mmc-muted');
    if(x.state==='stale')el('p','이 장에 들어간 장면이나 원문이 바뀌어 주입을 멈췄습니다. 합치기 취소로 원래 장면을 다시 켜거나, 취소한 뒤 다시 합치세요. 자동으로 다시 만들지는 않습니다.',d,'lv-warning');}
   else if(x.state==='stale')el('p','기록한 뒤 원문이 바뀌어(편집·스와이프·삭제) 주입을 멈췄습니다. 다시 기록하면 새 후보로 바꿀 수 있습니다.',d,'lv-warning');
   if(x.entryEdited){el('p','로어북 화면에서 이 엔트리 본문이 바뀌었습니다. 받아들이면 보관함 본문도 바뀝니다.',d,'lv-warning');const e=el('div',undefined,d,'lv-actions');
    button('받아들이기',()=>sceneSend('sceneEntry',{id:x.id,action:'accept'}),e).dataset.sceneAccept=x.id;button('되돌리기',()=>sceneSend('sceneEntry',{id:x.id,action:'revert'}),e);}
   const act=el('div',undefined,d,'lv-actions');
   button('고치기',()=>openEdit(x),act);
   if(x.kind==='scene')button('다시 기록',()=>{const box=rangesFor(chatId,c);box.rows=[{start:String(x.start),end:String(x.end)}];box.touched=true;ui.note(x.label+'을 구간 기록에 넣었습니다. 기록하기를 누르면 다시 기록합니다.');rerender();},act).dataset.sceneRedo=x.id;
   if(x.kind==='chapter')button('합치기 취소',()=>sceneSend('sceneUnmerge',{id:x.id}),act).dataset.sceneUnmerge=x.id;
   if(x.kind==='scene')button('삭제',async()=>{const opened=get();if(!await confirm({title:'장면 삭제',message:x.label+' 기록을 지우고 로어북 엔트리도 지웁니다. 되돌릴 수 없습니다.',variant:'danger',confirmLabel:'삭제',cancelLabel:'취소'}))return;if(get().chatId!==opened.chatId||get().epoch!==opened.epoch){ui.note('확인 창을 연 뒤 채팅이 바뀌어 지우지 않았습니다.');return;}sceneSend('sceneDelete',{id:x.id});},act,'mmc-danger');
  }
 }
 function book(parent,c){
  const box=card(parent,'로어북 · 설정');box.dataset.sceneBook='true';
  const s=c.settings;
  el('p',c.book?'로어북 「'+c.book.name+'」 · '+(c.book.attached?'이 채팅에 연결됨':'연결 안 됨 (주입 안 함)'):'로어북은 첫 장면을 공개로 승인할 때 「'+SCENE_BOOK_PREFIX+'…」 이름으로 이 채팅에만 만듭니다(채팅 이름은 넣지 않습니다).',box,c.book&&!c.book.attached?'lv-warning':'mmc-muted').dataset.sceneBookState=c.book?(c.book.attached?'attached':'detached'):'none';
  el('small','상시 '+c.nodes.filter(x=>x.mode==='constant').length+'개 ≈ '+c.constantTokens.toLocaleString('en-US')+' / '+s.budget.toLocaleString('en-US')+'토큰(추정) · 키워드 '+c.nodes.filter(x=>x.mode==='keyword').length+'개'+(c.hidden?' · 이 확장이 숨긴 원문 '+c.hidden+'개':''),box,'mmc-muted');
  const act=el('div',undefined,box,'lv-actions');
  button('다시 동기화',()=>sceneSend('sceneSync'),act).dataset.sceneSync='true';
  if(c.book)button(s.inject?'연결 해제':'다시 연결',()=>sceneSend('sceneBook',{action:s.inject?'detach':'attach'}),act);
  if(c.book)button('책 삭제',async()=>{const opened=get();if(!await confirm({title:'장면록 책 삭제',message:'「'+c.book.name+'」 로어북을 지웁니다. 보관함의 장면 기록은 남고 주입은 꺼집니다.',variant:'danger',confirmLabel:'책 삭제',cancelLabel:'취소'}))return;if(get().chatId!==opened.chatId||get().epoch!==opened.epoch){ui.note('확인 창을 연 뒤 채팅이 바뀌어 지우지 않았습니다.');return;}sceneSend('sceneBook',{action:'delete',confirm:true});},act,'mmc-danger');
  const more=el('details',undefined,box);el('summary','장면록 설정',more);
  const draft=(ui.sceneSettings||={});
  const num=(label,key,unit)=>{const l=el('label',undefined,more,'lv-num');el('span',label,l);number(l,label,draft[key]??String(s[key]),v=>draft[key]=v);el('span',unit+' ('+SCENE_LIMITS[key].join('–')+')',l);};
  num('상시 예산','budget','토큰');
  const kw=check('오래된 장면은 키워드로 켜기',more,draft.keywords??s.keywords);kw.onchange=()=>draft.keywords=kw.checked;
  num('키워드 검사: 최근','scanDepth','개 메시지');
  const hide=check('원문 자동 숨김 (상시 장면이 덮은 원문)',more,draft.autoHide??s.autoHide);hide.onchange=()=>draft.autoHide=hide.checked;hide.dataset.sceneHide='toggle';
  if(c.lumibooks&&!s.autoHide){hide.disabled=true;el('small','LumiBooks와 함께 쓰는 채팅이라 잠겼습니다.',more,'lv-warning');}
  num('숨기지 않을 최근','protectRecent','개 메시지');
  num('장면 길이 상한','maxBody','자');
  button('설정 저장',()=>{
   const out={keywords:draft.keywords??s.keywords,autoHide:draft.autoHide??s.autoHide};
   for(const k of ['budget','scanDepth','protectRecent','maxBody']){const v=strictInt(draft[k]??String(s[k])),[lo,hi]=SCENE_LIMITS[k];if(!Number.isSafeInteger(v)||v<lo||v>hi){ui.note('숫자는 '+lo+'~'+hi+' 사이 정수로 입력하세요.');return;}out[k]=v;}
   sceneSend('sceneSettings',out,reply=>{if(reply.ok)ui.sceneSettings={};return false;});
  },more,'mmc-sm').dataset.sceneSettings='save';
  el('small','상시: 가장 최근 장 1개와 장면 3개를 예산 안에서 늘 넣습니다. 나머지는 키워드가 최근 메시지에 나올 때만 들어갑니다. 원문 자동 숨김은 기본 꺼짐이며, 켜면 상시로 들어가는 장면이 덮은 원문만 숨기고(최근 메시지는 숨기지 않음) 이 확장이 숨긴 것만 되돌립니다.',more,'mmc-muted');
 }
 function section(main,chatId){
  if(!chatId)return;
  if(ui.sceneAsked!==chatId){ui.sceneAsked=chatId;send('count');sceneSend('sceneLoad');}
  const c=ui.chronicle?.chatId===chatId?ui.chronicle:null;
  const top=card(main,'장면록 · 구간 기록');top.dataset.scene='true';
  if(!c){el('p','장면록을 불러오는 중…',top,'mmc-muted');return;}
  if(!c.permission)el('p','장면록은 로어북(world_books) 권한이 필요합니다. 확장 관리에서 기억 보관함의 권한을 다시 승인한 뒤 새로고침하세요.',top,'lv-warning').dataset.scenePermission='missing';
  if(c.lumibooks)el('p','이 채팅에서 LumiBooks도 쓰고 있습니다. 같은 구간이 두 번 요약되어 들어가니 한쪽만 쓰기를 권합니다. 원문 자동 숨김은 잠겼습니다.',top,'lv-warning').dataset.sceneLumibooks='true';
  if(c.branch&&!c.book)el('p','분기한 채팅입니다. 분기점 앞에서 원문이 같은 장면만 가져왔고, 부모 채팅의 로어북은 이 채팅에서 떼어 냅니다.',top,'mmc-muted');
  recorder(top,chatId,c);
  el('small','루미버스 프리셋의 요약(Story Summary)도 켜 두었다면 같은 과거가 두 번 들어갈 수 있습니다.',top,'mmc-muted');
  candidates(main,c);records(main,c,chatId);book(main,c);
 }
 return {section};
}
