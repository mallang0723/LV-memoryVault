import {safe,clone,fingerprint,selectSource,sourceInput,sentStamp,spanLabel,strictInt,MAX_INPUT_CHARS,splitForInput,splitNote,chunkSpan} from './core.js';
import {SCENE_PROMPT,SCENE_MERGE_PROMPT,SCENE_PROMPT_VERSION,SCENE_MERGE_VERSION,SCENE_BOOK_PREFIX,SCENE_BOOK_KEY,SCENE_EXT,SCENE_MAX_CANDIDATES,SCENE_LIMITS,SCENE_SOURCE_LABEL,scenePrompt,sceneEmpty,sceneClean,sceneSettings,sceneLabel,sceneTokens,sceneBodyIssue,sceneKeywords,sceneParse,sceneEvaluate,sceneFrontier,scenePlan,sceneEntry,sceneValidateMerge,sceneJoinRange,sceneApplyMerge,sceneUndoMerge,sceneNextRange,sceneHidePlan,sceneInherit,sceneIdOk,sceneRestricted} from './chronicle.js';
// Scene chronicle service: chats/<id>/chronicle.json is the record, one chat-only world
// book mirrors it. Every handler below runs inside the per-chat queue of service.run()
// after the chat ownership check, so book lookup/creation for one chat is never
// concurrent (the 2026-10-14 removal of the old world-book path was about duplicate
// books; here a book is created only after the stored pointer and a full scan of the
// user's books both come up empty).
export const SCENE_TYPES=['sceneLoad','sceneRecord','sceneApprove','sceneDiscard','sceneEdit','sceneDelete','sceneMerge','sceneUnmerge','sceneSettings','sceneSync','sceneBook','sceneEntry'];
// Types that change the record and so must name the revision the panel last saw.
const SCENE_GUARDED=['sceneApprove','sceneDiscard','sceneEdit','sceneDelete','sceneMerge','sceneUnmerge','sceneSettings','sceneBook','sceneEntry'];
const scenePath=chatId=>'chats/'+chatId+'/chronicle.json';
const SCENE_HIDE_BATCH=500;
export const SCENE_PERMISSION_NOTICE='장면록은 로어북(world_books) 권한이 필요합니다. 확장 관리에서 기억 보관함의 권한을 다시 승인한 뒤 새로고침하세요. 다른 기능은 그대로 쓸 수 있습니다.';
export function createChronicle(api,{gate,rawTarget}){
 const owners=new Map();// book id -> owning chat id from its metadata ('' = not one of ours)
 const has=p=>{try{return api.permissions.has(p);}catch{return false;}};
 const digests=messages=>Promise.all((messages||[]).map(async m=>({id:m?.id,digest:await fingerprint(String(m?.content??'')),hidden:m?.extra?.hidden===true})));
 const exists=async(chatId,user)=>{try{return await api.userStorage.exists(scenePath(chatId),user);}catch{return false;}};
 async function readStored(chatId,user){
  if(!await api.userStorage.exists(scenePath(chatId),user))return null;
  return sceneClean(await api.userStorage.getJson(scenePath(chatId),{userId:user}));
 }
 // `bump`: false for bookkeeping the panel never edits (book pointer, entry IDs,
 // hidden-message ledger), so a background sync after a reply does not make an open
 // panel's next approval fail as out of date.
 async function save(chatId,user,s,bump=true){
  const v=sceneClean({...s,revision:s.revision+(bump?1:0)});safe(v);
  try{await api.userStorage.setJson(scenePath(chatId),v,{userId:user});}catch{
   let actual=null;try{actual=await readStored(chatId,user);}catch{}
   if(JSON.stringify(actual)!==JSON.stringify(v))throw Error('장면록 저장 미확정: 새로고침 후 확인하세요.');
  }
  return v;
 }
 // Stored record, or a branch's copy of its parent's verified nodes on first use.
 async function load(chatId,user,chat){
  const stored=await readStored(chatId,user);if(stored)return stored;
  const parentId=chat?.metadata?.branched_from;
  if(sceneIdOk(parentId)&&parentId!==chatId){
   let parent=null;try{if(await api.chats.get(parentId,user))parent=await readStored(parentId,user);}catch{}
   if(parent?.nodes.length){
    gate('chat_mutation');
    const [pm,cm]=await Promise.all([api.chat.getMessages(parentId).then(digests),api.chat.getMessages(chatId).then(digests)]);
    return save(chatId,user,sceneInherit(parent,pm,cm,chat.metadata.branch_at_message,parentId));
   }
  }
  return sceneEmpty();
 }
 const sameChat=(b,chatId)=>!!b&&b.metadata&&typeof b.metadata==='object'&&b.metadata[SCENE_BOOK_KEY]===chatId;
 // Every book of this user whose metadata names this chat, oldest first.
 async function scanBooks(chatId,user){
  const out=[];
  for(let offset=0,guard=0;guard<500;guard++){
   const page=await api.world_books.list({limit:200,offset,userId:user}),data=Array.isArray(page?.data)?page.data:[];
   for(const b of data){if(!b||!sceneIdOk(b.id))continue;const owner=typeof b.metadata?.[SCENE_BOOK_KEY]==='string'?b.metadata[SCENE_BOOK_KEY]:'';owners.set(b.id,owner);if(owner===chatId)out.push(b);}
   offset+=data.length;if(!data.length||offset>=(Number(page?.total)||0))break;
  }
  return out.sort((a,b)=>(a.created_at||0)-(b.created_at||0)||String(a.id).localeCompare(String(b.id)));
 }
 // Idempotent: stored pointer (verified by the book's own chat id) → full scan → create.
 // A create whose reply is lost is found by the scan that follows the error.
 async function ensureBook(chatId,user,s,create=true){
  gate('world_books');
  if(s.book){let b=null;try{b=await api.world_books.get(s.book.id,user);}catch{}if(sameChat(b,chatId))return {book:b,duplicates:0};}
  let found=await scanBooks(chatId,user);
  if(!found.length&&!create)return {book:null,duplicates:0};
  if(!found.length){
   const name=SCENE_BOOK_PREFIX+(await fingerprint(chatId)).slice(7,13);
   try{const b=await api.world_books.create({name,description:'',metadata:{[SCENE_BOOK_KEY]:chatId}},user);if(sameChat(b,chatId)){owners.set(b.id,chatId);return {book:b,duplicates:0,created:true};}}catch(error){
    found=await scanBooks(chatId,user);if(!found.length)throw Error('장면록 로어북을 만들지 못했습니다: '+String(error?.message||error));
   }
   if(!found.length)found=await scanBooks(chatId,user);
   if(!found.length)throw Error('장면록 로어북을 만들었지만 확인하지 못했습니다. 새로고침 후 다시 시도하세요.');
  }
  return {book:found[0],duplicates:found.length-1};
 }
 async function ownerOf(id,user){
  if(owners.has(id))return owners.get(id);
  let b=null;try{b=await api.world_books.get(id,user);}catch{return '';}
  const owner=typeof b?.metadata?.[SCENE_BOOK_KEY]==='string'?b.metadata[SCENE_BOOK_KEY]:'';owners.set(id,owner);return owner;
 }
 // Chat attachment. chats.update replaces metadata as a whole, so the chat is read
 // right before and every other key is carried over unchanged. Written only when the
 // list actually changes: our book added/removed, or another chat's book of ours
 // (copied into a branch by the host) dropped.
 async function attach(chatId,user,bookId,on){
  gate('chats');const chat=await api.chats.get(chatId,user);if(!chat)throw Error('채팅 소유권 확인 실패');
  const meta=chat.metadata&&typeof chat.metadata==='object'?chat.metadata:{};
  const ids=Array.isArray(meta.chat_world_book_ids)?meta.chat_world_book_ids:[];
  const keep=[];let foreign=0;
  for(const id of ids){
   if(typeof id!=='string'){keep.push(id);continue;}
   if(id===bookId){if(on)keep.push(id);continue;}
   const owner=has('world_books')&&sceneIdOk(id)?await ownerOf(id,user):'';
   if(owner&&owner!==chatId){foreign++;continue;}
   keep.push(id);
  }
  if(on&&bookId&&!keep.includes(bookId))keep.push(bookId);
  if(JSON.stringify(keep)===JSON.stringify(ids))return {changed:false,foreign:0,attached:!!bookId&&keep.includes(bookId)};
  await api.chats.update(chatId,{metadata:{...meta,chat_world_book_ids:keep}},user);
  return {changed:true,foreign,attached:!!bookId&&keep.includes(bookId)};
 }
 async function listEntries(bookId,user){
  const out=[];
  for(let offset=0,guard=0;guard<500;guard++){
   const page=await api.world_books.entries.list(bookId,{limit:200,offset,userId:user}),data=Array.isArray(page?.data)?page.data:[];
   out.push(...data);offset+=data.length;if(!data.length||offset>=(Number(page?.total)||0))break;
  }
  return out;
 }
 const ENTRY_FIELDS=['comment','content','constant','disabled','position','order_value','scan_depth','match_whole_words','case_sensitive','prevent_recursion','exclude_recursion','selective','use_regex'];
 const differs=(cur,want)=>ENTRY_FIELDS.some(k=>k in want&&JSON.stringify(cur?.[k]??null)!==JSON.stringify(want[k]))||JSON.stringify(cur?.key||[])!==JSON.stringify(want.key)||JSON.stringify(cur?.extensions?.[SCENE_EXT]||null)!==JSON.stringify(want.extensions[SCENE_EXT]);
 // Mirrors the record into the book, the chat attachment and (opt-in) hidden turns.
 // `force`: node IDs whose body overwrites a book entry the user edited by hand.
 async function sync(chatId,user,chat,s,{all,force=[]}={}){
  const report={permission:has('world_books'),created:0,updated:0,removed:0,foreign:0,hidden:0,unhidden:0,errors:[]};
  if(!all){gate('chat_mutation');all=await api.chat.getMessages(chatId);}
  const msgs=await digests(all),evaluation=sceneEvaluate(s,msgs),p=scenePlan(s,evaluation);
  const book=report.permission&&(s.settings.inject||s.nodes.some(x=>x.entry))&&(s.book||s.nodes.some(x=>p.plan.get(x.id)!=='none'));
  const found=book?await ensureBook(chatId,user,s,s.settings.inject):null;
  if(book&&!found.book){s.book=null;for(const x of s.nodes){x.entry=null;x.entryEdited=false;}}
  if(found?.book){
   report.duplicates=found.duplicates;
   if(!s.book||s.book.id!==found.book.id){s.book={id:found.book.id,name:String(found.book.name||'')};for(const x of s.nodes){x.entry=null;x.entryEdited=false;}s=await save(chatId,user,s,false);}
   const entries=await listEntries(s.book.id,user),byId=new Map(entries.map(e=>[e.id,e])),byNode=new Map();
   for(const e of entries){const ext=e?.extensions?.[SCENE_EXT];if(!ext||!sceneIdOk(ext.nodeId))continue;if(!byNode.has(ext.nodeId))byNode.set(ext.nodeId,[]);byNode.get(ext.nodeId).push(e);}
   const used=new Set();
   for(const x of s.nodes){
    const mode=p.plan.get(x.id),cur=(x.entry&&byId.get(x.entry.id))||(byNode.get(x.id)||[])[0]||null;
    if(mode==='none'){x.entry=null;x.entryEdited=false;continue;}// its entry, if any, is removed below
    const want=sceneEntry(x,mode,s.settings,chatId),hash=await fingerprint(want.content);
    if(cur){
     used.add(cur.id);const curHash=await fingerprint(String(cur.content??''));
     const edited=!!x.entry?.hash&&curHash!==x.entry.hash&&curHash!==hash&&!force.includes(x.id);
     if(edited){delete want.content;x.entryEdited=true;}else x.entryEdited=false;
     if(differs(cur,want)){await api.world_books.entries.update(cur.id,want,user);report.updated++;}
     x.entry={id:cur.id,hash:edited?x.entry.hash:hash};
    }else{const made=await api.world_books.entries.create(s.book.id,want,user);used.add(made.id);x.entry={id:made.id,hash};x.entryEdited=false;report.created++;}
   }
   // Our marked entries that no node uses any more (deleted or private scenes,
   // duplicates left by a lost reply). Unmarked entries a user added are left alone.
   for(const e of entries){if(!e?.extensions?.[SCENE_EXT]||used.has(e.id))continue;try{await api.world_books.entries.delete(e.id,user);report.removed++;}catch(error){report.errors.push('엔트리 정리 실패: '+String(error?.message||error));}}
  }
  // Attach while enabled; detach when the user turned the book off. Branch copies of
  // another chat's book are dropped either way.
  if(report.permission){const r=await attach(chatId,user,s.book?.id||null,!!s.book&&s.settings.inject);report.foreign=r.foreign;report.attached=r.attached;}
  // Hiding: opt-in, only while our entries actually reach the prompt (injection on,
  // our book attached); frozen while LumiBooks manages the same chat. Detached,
  // deleted or turned off: every message we hid comes back.
  const injected=report.permission&&s.settings.inject&&!!s.book&&report.attached===true;
  const locked=!!chat?.metadata?.lumibooks_book_id,hp=sceneHidePlan(s,p,msgs,{locked,injected});
  const ours=new Set(hp.hiddenByUs);
  if((hp.hide.length||hp.unhide.length)&&typeof api.chat.setMessagesHidden==='function'){
   gate('chat_mutation');if(!await api.chats.get(chatId,user))throw Error('채팅 소유권 확인 실패');
   for(const [list,hidden] of [[hp.unhide,false],[hp.hide,true]])for(let i=0;i<list.length;i+=SCENE_HIDE_BATCH){const part=list.slice(i,i+SCENE_HIDE_BATCH);
    try{await api.chat.setMessagesHidden(chatId,part,hidden);report[hidden?'hidden':'unhidden']+=part.length;}catch(error){for(const id of part)hidden?ours.delete(id):ours.add(id);report.errors.push('숨김 '+(hidden?'적용':'해제')+' 실패: '+String(error?.message||error));}}
  }else if(hp.hide.length||hp.unhide.length){ours.clear();for(const id of s.hiddenByUs)if(msgs.some(m=>m.id===id&&m.hidden))ours.add(id);}
  s.hiddenByUs=[...ours];s.keepVisible=hp.keepVisible;
  return {s,evaluation,plan:p,report,msgs};
 }
 const changed=(a,b)=>JSON.stringify({...a,revision:0})!==JSON.stringify({...b,revision:0});
 async function syncAndSave(chatId,user,chat,s,opts){
  const before=clone(s),out=await sync(chatId,user,chat,s,opts);
  if(changed(before,out.s))out.s=await save(chatId,user,out.s,false);
  return out;
 }
 // Panel view: our own records and message numbers only. Message IDs, digests and
 // message bodies never leave the worker.
 function view(s,evaluation,p,{total=null,chat,report}={}){
  const row=(x,candidate)=>({id:x.id,kind:x.kind,label:sceneLabel(x),title:x.title,body:x.body,keywords:x.keywords,scope:x.scope,start:x.range.start,end:x.range.end,count:x.range.ids.length,revision:x.revision,tokens:sceneTokens(x.body),
   ...(candidate?{replaces:x.replaces||''}:{state:evaluation?.get(x.id)?.state||'stale',reason:evaluation?.get(x.id)?.reason||'',mode:p?.plan.get(x.id)||'none',parentId:x.parentId,children:(x.children||[]).map(c=>c.id),entry:!!x.entry,entryEdited:!!x.entryEdited})});
  const ids=Array.isArray(chat?.metadata?.chat_world_book_ids)?chat.metadata.chat_world_book_ids:[];
  return {revision:s.revision,nodes:s.nodes.map(x=>row(x,false)),candidates:s.candidates.map(x=>row(x,true)),settings:s.settings,
   book:s.book?{name:s.book.name,ref:s.book.id,attached:ids.includes(s.book.id)}:null,constantTokens:p?.constantTokens||0,
   permission:has('world_books'),lumibooks:!!chat?.metadata?.lumibooks_book_id,branch:!!s.branchFrom,hidden:s.hiddenByUs.length,
   next:Number.isSafeInteger(total)?sceneNextRange(s,total):null,total,...(report?{report:{...report,errors:report.errors.slice(0,3)}}:{})};
 }
 const syncNotice=r=>[r.created||r.updated?'로어북 엔트리 '+(r.created?'추가 '+r.created+'개':'')+(r.created&&r.updated?' · ':'')+(r.updated?'갱신 '+r.updated+'개':''):'',r.removed?'엔트리 정리 '+r.removed+'개':'',r.foreign?'분기 전 채팅의 장면록 연결 '+r.foreign+'개 해제':'',r.hidden?'원문 '+r.hidden+'개 숨김':'',r.unhidden?'원문 '+r.unhidden+'개 숨김 해제':'',r.duplicates?'같은 채팅 장면록 책 '+r.duplicates+'개가 더 있어 가장 오래된 책을 씁니다':'',...r.errors].filter(Boolean).join(' · ');
 const needModel=r=>{if(!['raw','quiet'].includes(r.mode)||!sceneIdOk(r.connection))throw Error('모델 연결 확인 필요: 설정 탭에서 분석 모드와 모델 연결을 고르세요.');};
 // One range = one model call. Returns the scene candidate (stored here) and the
 // promise / flow lines from the same response for the caller to queue as candidates.
 async function record(r,{chatId,user,chat}){
  gate('world_books');gate('generation');gate('chat_mutation');needModel(r);
  if(r.source?.scope!=='range'||!Array.isArray(r.source.ranges)||r.source.ranges.length!==1)throw Error('장면은 범위 하나씩 기록합니다.');
  const target=r.mode==='raw'?await rawTarget(r.connection,user):{};
  let s=await load(chatId,user,chat);
  if(s.candidates.length>=SCENE_MAX_CANDIDATES)throw Error('검토 대기 장면이 '+SCENE_MAX_CANDIDATES+'개입니다. 먼저 승인하거나 버리세요.');
  const all=await api.chat.getMessages(chatId),source=selectSource(all,r.source),[start,end]=source.spans[0];
  const label=spanLabel([[start,end]]);
  // Over the input limit: split at message boundaries; each chunk becomes its own scene
  // (one call each, in order). A message too large alone is left out with a note.
  const split=splitForInput(source.picked,r.timeZone),note=splitNote(label,split,'기록');
  if(!split.chunks.length)throw Error('원문 크기 초과: '+source.text+'의 메시지가 하나만으로도 '+MAX_INPUT_CHARS.toLocaleString('en-US')+'자 한도를 넘어 기록할 수 없습니다. 그 메시지는 잘라 보내지 않습니다.');
  if(s.candidates.length+split.chunks.length>SCENE_MAX_CANDIDATES)throw Error('이 구간은 장면 '+split.chunks.length+'개로 나뉘는데 검토 대기 장면 자리가 모자랍니다('+SCENE_MAX_CANDIDATES+'개까지). 먼저 승인하거나 버리세요.');
  const msgs=await digests(all),evaluation=sceneEvaluate(s,msgs),frontier=sceneFrontier(s,evaluation);
  const ids=source.picked.map(x=>x.m.id);
  // Checked before paying for a call: a range may only repeat one active scene exactly
  // (re-record) and must not overlap any other active record.
  const hit=frontier.filter(x=>x.range.ids.some(id=>ids.includes(id)));
  const same=hit.length===1&&hit[0].kind==='scene'&&JSON.stringify(hit[0].range.ids)===JSON.stringify(ids)?hit[0]:null;
  if(hit.length&&!same)throw Error(sceneLabel(hit[0])+'과 범위가 겹칩니다. 겹치지 않게 고르거나, 같은 장면을 다시 기록하려면 시작·끝을 그 장면과 똑같이 맞추세요.'+(hit[0].kind==='chapter'?' 장은 합치기 취소 뒤 다시 기록할 수 있습니다.':''));
  if(same&&(split.chunks.length>1||split.skipped.length))throw Error(sceneLabel(same)+'은 지금 원문이 한도를 넘어 장면 하나로 다시 기록할 수 없습니다('+note+'). 이 장면을 지운 뒤 같은 구간을 기록하면 여러 장면으로 나눠 기록합니다.');
  // Reference only: the closest earlier active record that is not secret; for a later
  // chunk, the scene just written for the chunk before it.
  const firstIndex=source.picked[0].index;
  let prev=frontier.filter(x=>x!==same&&['public','unknown'].includes(x.scope)&&evaluation.get(x.id)?.state==='approved'&&evaluation.get(x.id).loc.endIndex<firstIndex).at(-1)?.body||'';
  const system=scenePrompt(SCENE_PROMPT,s.settings.maxBody),made=[],proposals=[],failed=[];
  for(const chunk of split.chunks){
   const [a,b]=chunkSpan(chunk),part=spanLabel([[a,b]]),input=sourceInput(chunk.map(x=>x.m),r.timeZone);
   const user_=(prev?'〈이전 기록〉\n'+prev+'\n〈/이전 기록〉\n\n':'')+'〈원문〉\n'+input+'\n〈/원문〉';
   try{
    gate('generation');
    const generated=await api.generate[r.mode]({messages:[{role:'system',content:system},{role:'user',content:user_}],connection_id:r.connection,userId:user,...target});
    const stamp=sentStamp(chunk.at(-1).m,r.timeZone),parsed=sceneParse(generated?.content,stamp?'기록 '+stamp:'시각 미상');
    s.candidates.push({id:crypto.randomUUID(),kind:'scene',title:parsed.title,body:parsed.body,keywords:parsed.keywords,scope:'unknown',status:'candidate',revision:1,range:{ids:chunk.map(x=>x.m.id),fps:chunk.map(x=>msgs[x.index].digest),start:a,end:b},parentId:'',...(same?{replaces:same.id}:{}),
     generation:{promptVersion:SCENE_PROMPT_VERSION,model:String(target.model||''),connection:r.connection,inputHash:await fingerprint(system+'\n'+user_),at:Date.now()},at:Date.now()});
    made.push(part);prev=parsed.body;
    const evidence=chunk.map(({m,index})=>({id:m.id,index,fingerprint:msgs[index].digest}));
    for(const [layer,list] of [['promises',parsed.promises],['flows',parsed.flows]])for(const text of list)proposals.push({layer,text,evidence,source:SCENE_SOURCE_LABEL+' · '+part});
   }catch(error){if(split.chunks.length===1)throw error;failed.push(part+' 실패: '+error.message);}
  }
  if(!made.length)throw Error(note+' · 모든 조각 실패: '+failed.join(' / '));
  s=await save(chatId,user,s);
  const ev2=sceneEvaluate(s,msgs),p2=scenePlan(s,ev2);
  return {chronicle:view(s,ev2,p2,{total:all.length,chat}),proposals,
   notice:label+' 장면 기록 · 검토 대기에 장면 후보 '+made.length+'개'+(same?'(다시 기록)':'')+(note?' · '+note+'(장면 '+made.length+'개)':'')+(failed.length?' · '+failed.join(' / '):'')+(proposals.length?' · 약속·진행 흐름 후보 '+proposals.length+'개는 기억 검토 대기에':'')+' · 승인하면 로어북에 씁니다'};
 }
 async function merge(r,s,ctx,msgs){
  gate('generation');needModel(r);
  const evaluation=sceneEvaluate(s,msgs),v=sceneValidateMerge(s,evaluation,r.ids);if(!v.ok)throw Error(v.error);
  if(s.candidates.length>=SCENE_MAX_CANDIDATES)throw Error('검토 대기 장면이 '+SCENE_MAX_CANDIDATES+'개입니다. 먼저 승인하거나 버리세요.');
  const target=r.mode==='raw'?await rawTarget(r.connection,ctx.user):{};
  const system=scenePrompt(SCENE_MERGE_PROMPT,s.settings.mergeBody),input=v.nodes.map((x,i)=>'〈기록 '+(i+1)+'〉\n'+x.body+'\n〈/기록 '+(i+1)+'〉').join('\n\n');
  gate('generation');
  const generated=await api.generate[r.mode]({messages:[{role:'system',content:system},{role:'user',content:input}],connection_id:r.connection,userId:ctx.user,...target});
  const first=String(v.nodes[0].body.match(/^\s*\[([^\]\n]{1,80})\]/)?.[1]||''),parsed=sceneParse(generated?.content,first||'시각 미상');
  s.candidates.push({id:crypto.randomUUID(),kind:'chapter',title:parsed.title,body:parsed.body,keywords:parsed.keywords,scope:v.scope,status:'candidate',revision:1,range:sceneJoinRange(v.nodes),children:v.nodes.map(x=>({id:x.id,revision:x.revision})),parentId:'',
   generation:{promptVersion:SCENE_MERGE_VERSION,model:String(target.model||''),connection:r.connection,inputHash:await fingerprint(system+'\n'+input),at:Date.now()},at:Date.now()});
  return {s,notice:v.nodes.map(sceneLabel).join(' + ')+' 합치기 후보 1개 · 승인하면 합친 장이 들어가고 원래 장면은 보관됩니다(합치기 취소 가능)'};
 }
 const findNode=(s,id)=>{const x=s.nodes.find(y=>y.id===id);if(!x)throw Error('장면록 항목이 없습니다. 새로고침하세요.');return x;};
 const findCandidate=(s,id)=>{const x=s.candidates.find(y=>y.id===id);if(!x)throw Error('장면 후보가 없습니다. 새로고침하세요.');return x;};
 const restricted=x=>['secret','character'].includes(x.scope);
 // Requests from the panel (and internal event syncs) other than sceneRecord.
 async function handle(r,{chatId,user,chat}){
  if(r.type==='sceneSync'&&r.quiet&&!await exists(chatId,user)&&!sceneIdOk(chat?.metadata?.branched_from))return {skip:'none'};
  if(r.type!=='sceneLoad'&&r.type!=='sceneSync')gate('world_books');
  gate('chat_mutation');
  let s=await load(chatId,user,chat);
  if(SCENE_GUARDED.includes(r.type)&&r.sceneRevision!==s.revision)throw Error('장면록이 그사이 바뀌었습니다. 새로고침 후 다시 하세요.');
  const all=await api.chat.getMessages(chatId),msgs=await digests(all);
  let notice='',force=[],sync=r.type==='sceneSync'?has('world_books'):r.type!=='sceneLoad';
  if(r.type==='sceneApprove'){
   const c=findCandidate(s,r.id),scope=r.scope==='public'?'public':'unknown';
   const issue=sceneBodyIssue(c.body);if(issue)throw Error(issue+' 고치기에서 본문을 고친 뒤 승인하세요.');
   if(scope==='public'&&restricted(c))throw Error('비밀·인물 제한 장면은 로어북에 쓰지 않습니다. 범위를 바꾸려면 고치기에서 확인하세요.');
   if(scope==='public'&&r.confirmPublic!==true)throw Error('공개 범위 확대: 명시 확인 필요');
   const evaluation=sceneEvaluate(s,msgs),keep=restricted(c)?c.scope:scope;
   if(c.kind==='scene'){
    const pos=new Map(msgs.map((m,i)=>[m.id,i])),at=c.range.ids.map(id=>pos.get(id));
    if(at.some((i,k)=>i===undefined||(k&&i!==at[k-1]+1)||msgs[i].digest!==c.range.fps[k]))throw Error('기록한 뒤 원문이 바뀌었습니다. 이 후보를 버리고 다시 기록하세요.');
    const hit=sceneFrontier(s,evaluation).filter(x=>x.id!==c.replaces&&x.range.ids.some(id=>c.range.ids.includes(id)));
    if(hit.length)throw Error(sceneLabel(hit[0])+'과 범위가 겹쳐 승인하지 않습니다. 이 후보를 버리거나 그 장면을 먼저 정리하세요.');
    const old=c.replaces&&s.nodes.find(x=>x.id===c.replaces);
    if(c.replaces&&(!old||old.parentId||old.status==='undone'||JSON.stringify(old.range.ids)!==JSON.stringify(c.range.ids)))throw Error('다시 기록할 장면이 바뀌었습니다. 이 후보를 버리고 다시 기록하세요.');
    if(old)Object.assign(old,{title:c.title,body:c.body,keywords:c.keywords,scope:keep,status:'approved',range:c.range,generation:c.generation,revision:old.revision+1,at:Date.now()});
    else s.nodes.push({...c,status:'approved',scope:keep,entry:null,entryEdited:false,at:Date.now()});
   }else{
    const v=sceneValidateMerge(s,evaluation,c.children.map(x=>x.id));if(!v.ok)throw Error(v.error);
    if(scope==='public'&&v.scope!=='public')throw Error('비공개 장면을 합친 장은 공개로 승인할 수 없습니다. 비공개로 보관하세요.');
    s=sceneApplyMerge(s,{...c,scope:keep,at:Date.now()});
   }
   s.candidates=s.candidates.filter(x=>x.id!==c.id);
   notice=sceneLabel(c)+(keep==='public'?' 승인 · 로어북에 씁니다':' 비공개로 보관 · 로어북에 쓰지 않습니다');
  }else if(r.type==='sceneDiscard'){const c=findCandidate(s,r.id);s.candidates=s.candidates.filter(x=>x!==c);notice=sceneLabel(c)+' 후보를 버렸습니다';sync=false;}
  else if(r.type==='sceneEdit'){
   const isCandidate=s.candidates.some(x=>x.id===r.id),x=isCandidate?findCandidate(s,r.id):findNode(s,r.id);
   const body=r.body===undefined?x.body:String(r.body).trim(),issue=sceneBodyIssue(body);if(issue)throw Error(issue);
   const scope=r.scope===undefined?x.scope:r.scope;
   if(!['public','unknown','secret'].includes(scope)||(isCandidate&&scope==='public'))throw Error('공개 범위 형식 오류');
   if(scope==='public'&&x.scope!=='public'&&r.confirmPublic!==true)throw Error('공개 범위 확대: 명시 확인 필요');
   const content=body!==x.body||String(r.title??x.title)!==x.title||JSON.stringify(r.keywords===undefined?x.keywords:sceneKeywords(r.keywords))!==JSON.stringify(x.keywords);
   // A scope change is a change the chapters above depend on too: narrowing it must
   // withdraw every chapter that carries this text (they become stale and lose their
   // entries), so it bumps the revision like an edited body.
   const rescoped=scope!==x.scope,narrowed=rescoped&&x.scope==='public';
   Object.assign(x,{body,title:String(r.title??x.title).replace(/\s+/g,' ').trim().slice(0,40),keywords:r.keywords===undefined?x.keywords:sceneKeywords(r.keywords),scope});
   if(!isCandidate&&(content||rescoped))x.revision++;
   if(!isCandidate&&content)force=[x.id];
   notice=sceneLabel(x)+' 저장'+(!isCandidate&&narrowed?' · 로어북에서 빼고, 이 장면을 담은 장도 모두 주입을 멈춥니다':!isCandidate&&(content||rescoped)?' · 이 장면을 담은 장은 갱신 필요로 바뀝니다':'');sync=!isCandidate;
  }else if(r.type==='sceneDelete'){
   const x=findNode(s,r.id);if(x.kind!=='scene')throw Error('장은 지우지 않고 합치기 취소로 풉니다.');if(x.parentId&&s.nodes.some(y=>y.id===x.parentId&&y.status!=='undone'))throw Error('장에 들어간 장면은 먼저 합치기를 취소하세요.');
   s.nodes=s.nodes.filter(y=>y!==x);notice=sceneLabel(x)+' 삭제 · 로어북 엔트리도 지웁니다';
  }else if(r.type==='sceneMerge'){const out=await merge(r,s,{chatId,user},msgs);s=out.s;notice=out.notice;sync=false;}
  else if(r.type==='sceneUnmerge'){const out=sceneUndoMerge(s,r.id);s=out.state;notice='합치기 취소 · 장 '+out.undone.length+'개를 비활성 이력으로 두고 원래 장면을 다시 켰습니다(모델 호출 없음)';}
  else if(r.type==='sceneSettings'){
   const next={...s.settings};const num=(k)=>{if(r[k]===undefined)return;const n=strictInt(r[k]),[lo,hi]=SCENE_LIMITS[k];if(!Number.isSafeInteger(n)||n<lo||n>hi)throw Error(({budget:'상시 예산',scanDepth:'키워드 검사 깊이',protectRecent:'숨김 보호 개수',maxBody:'장면 길이 상한',mergeBody:'합친 장 길이 상한'})[k]+'은 '+lo+'~'+hi+' 사이 정수로 입력하세요.');next[k]=n;};
   for(const k of Object.keys(SCENE_LIMITS))num(k);
   if(r.keywords!==undefined)next.keywords=r.keywords===true;
   if(r.autoHide!==undefined){if(r.autoHide===true&&!s.settings.autoHide&&chat?.metadata?.lumibooks_book_id)throw Error('이 채팅에서 LumiBooks를 쓰고 있어 원문 자동 숨김을 켤 수 없습니다(서로 숨김을 풀어 버립니다).');next.autoHide=r.autoHide===true;}
   s.settings=sceneSettings(next);notice='장면록 설정 저장'+(s.settings.autoHide&&!s.settings.inject?' · 로어북 연결이 꺼져 있어 원문을 숨기지 않습니다(다시 연결하면 숨깁니다)':'');
  }else if(r.type==='sceneBook'){
   if(r.action==='attach'||r.action==='detach'){s.settings={...s.settings,inject:r.action==='attach'};notice=r.action==='attach'?'장면록 로어북을 이 채팅에 연결합니다':'장면록 로어북 연결 해제 · 장면록은 주입되지 않습니다(기록은 그대로)';}
   else if(r.action==='delete'){
    if(r.confirm!==true)throw Error('책 삭제 명시 확인 필요');
    // Bound to the book the confirmation named (the pointer can move without a revision change).
    if((s.book?.id||'')!==(typeof r.bookRef==='string'?r.bookRef:''))throw Error('확인한 장면록 책이 그사이 바뀌었습니다. 새로고침 후 다시 하세요.');
    if(s.book){let b=null;try{b=await api.world_books.get(s.book.id,user);}catch{}
     if(b&&sameChat(b,chatId)){await attach(chatId,user,s.book.id,false);await api.world_books.delete(s.book.id,user);owners.delete(s.book.id);}}
    s.book=null;s.settings={...s.settings,inject:false};for(const x of s.nodes){x.entry=null;x.entryEdited=false;}
    notice='장면록 로어북을 지웠습니다 · 기록은 보관함에 남아 있고 주입은 꺼졌습니다. 다시 연결하면 새 책을 만듭니다';
   }else throw Error('알 수 없는 책 작업');
  }else if(r.type==='sceneEntry'){
   const x=findNode(s,r.id);if(!x.entryEdited||!x.entry)throw Error('로어북에서 바뀐 엔트리가 아닙니다.');
   if(r.action==='revert'){force=[x.id];notice=sceneLabel(x)+' 로어북 엔트리를 보관함 본문으로 되돌립니다';}
   else if(r.action==='accept'){const e=await api.world_books.entries.get(x.entry.id,user);const body=String(e?.content??'').trim(),issue=sceneBodyIssue(body);if(issue)throw Error('로어북에서 고친 본문을 받아들일 수 없습니다: '+issue);
    x.body=body;x.revision++;x.entryEdited=false;x.entry={id:x.entry.id,hash:await fingerprint(body)};notice=sceneLabel(x)+' 로어북에서 고친 본문을 받아들였습니다 · 이 장면을 담은 장은 갱신 필요로 바뀝니다';}
   else throw Error('알 수 없는 엔트리 작업');
  }
  const mutated=r.type!=='sceneLoad'&&r.type!=='sceneSync';
  if(mutated)s=await save(chatId,user,s);
  // A branch opened for the first time drops the parent's book and gets its own.
  if(r.type==='sceneLoad'&&s.branchFrom&&!s.book&&s.nodes.length&&has('world_books'))sync=true;
  let evaluation,p,report;
  if(sync){const out=await syncAndSave(chatId,user,chat,s,{all,force});s=out.s;evaluation=out.evaluation;p=out.plan;report=out.report;const n=syncNotice(report);if(n)notice=[notice,n].filter(Boolean).join(' · ');}
  else{evaluation=sceneEvaluate(s,msgs);p=scenePlan(s,evaluation);}
  const fresh=(sync?await api.chats.get(chatId,user):null)||chat;
  return {chronicle:view(s,evaluation,p,{total:all.length,chat:fresh,report}),...(notice?{notice}:{})};
 }
 // World-info interceptor (fail-safe behind the event-driven sync): any entry this
 // extension wrote is turned off for this prompt unless injection is on, it belongs to
 // this chat's own book and its node is approved, public (every node below it public
 // too) and unchanged against the messages the host
 // is assembling from. Errors turn our entries off; other entries are never touched.
 async function worldInfoGuard(ctx){
  const ours=(Array.isArray(ctx?.entries)?ctx.entries:[]).filter(e=>e?.extensions&&typeof e.extensions==='object'&&e.extensions[SCENE_EXT]);
  if(!ours.length)return;
  const off=ours.map(e=>e.id);
  try{
   const user=ctx.userId,chatId=ctx.chatId;
   if(!sceneIdOk(chatId)||typeof user!=='string'||!user||!await api.chats.get(chatId,user))return {disabled:off};
   const s=await readStored(chatId,user);if(!s?.book||!s.settings.inject)return {disabled:off};
   const msgs=await digests(Array.isArray(ctx.messages)?ctx.messages:[]),evaluation=sceneEvaluate(s,msgs),plan=scenePlan(s,evaluation).plan,restricted=sceneRestricted(s);
   // Revision alone is not enough: a node narrowed below public at any depth withdraws
   // every chapter above it.
   const disabled=ours.filter(e=>{const ext=e.extensions[SCENE_EXT],x=s.nodes.find(y=>y.id===ext?.nodeId);
    return !(ext.chatId===chatId&&e.world_book_id===s.book.id&&x&&x.scope==='public'&&!restricted.has(x.id)&&x.entry?.id===e.id&&x.revision===ext.revision&&evaluation.get(x.id)?.state==='approved'&&['constant','keyword'].includes(plan.get(x.id)));}).map(e=>e.id);
   return disabled.length?{disabled}:undefined;
  }catch{return {disabled:off};}
 }
 return {record,handle,worldInfoGuard,view,load,exists};
}
