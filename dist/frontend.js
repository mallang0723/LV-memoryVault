export const layers=['promises','anchors','elements','scenes','flows','wiki'];
export const layerNames={promises:'약속',anchors:'기억 앵커',elements:'요소 기억',scenes:'장면 기억',flows:'진행 흐름',wiki:'이야기 위키'};
export const injectionText=items=>items.map(x=>layerNames[x.layer]+': '+x.text).join('\n');
export const empty=()=>({version:1,revision:0,items:[],candidates:[],undo:[]});
export const clone=x=>JSON.parse(JSON.stringify(x));
export const lifecycleLayers=['promises','flows'];
export function safe(x){
 const raw=typeof x==='string'?x:JSON.stringify(x);
 if(new TextEncoder().encode(raw).byteLength>2000000) throw Error('크기 제한 2MB');
 return JSON.parse(raw,(k,v)=>{if(['__proto__','constructor','prototype'].includes(k)) throw Error('위험한 키');return v;});
}
// Model output for analysis. A response that is already valid JSON is used exactly
// as returned, so text inside JSON strings is never edited. Only when it is not
// valid JSON are leading reasoning blocks (<think>…</think>), fences and prose
// skipped. The outermost JSON value is located first and used as a whole: a cut-off
// outer array fails instead of falling back to an array nested inside it. Size and
// dangerous-key errors always propagate.
const MAX_RESPONSE_BYTES=2000000;
const balancedValue=(s,start)=>{let depth=0,str=false,esc=false;
 for(let i=start;i<s.length;i++){const c=s[i];
  if(str){if(esc)esc=false;else if(c==='\\')esc=true;else if(c==='"')str=false;continue;}
  if(c==='"')str=true;else if(c==='['||c==='{')depth++;else if((c===']'||c==='}')&&--depth===0)return i+1;}
 return -1;};
export const CANDIDATE_KEYS=['candidates','memories','items'];
export const PROPOSAL_KEYS=['proposals','changes','actions','candidates','items'];
const unwrapList=(v,keys)=>Array.isArray(v)?v:v&&typeof v==='object'?keys.map(k=>v[k]).find(Array.isArray):undefined;
const parseFail=content=>{const head=content.trim().slice(0,120);return Error('모델 응답을 JSON 배열로 해석하지 못했습니다. 응답이 잘렸거나 형식이 다릅니다. 다시 시도하거나 다른 모델·모드를 선택하세요. 응답 앞부분: '+(head||'(빈 응답)')+(content.trim().length>120?'…':''));};
const tryParse=text=>{try{return {value:safe(text)};}catch(error){if(error instanceof SyntaxError)return null;throw error;}};
// Scan prose for the first top-level JSON value. A region that is balanced but not
// usable is skipped as a whole (never searched inside); an unbalanced one ends the scan.
function locate(text,keys){
 for(let i=text.search(/[[{]/);i>=0;){
  const end=balancedValue(text,i);if(end<0)return {truncated:true};
  const r=tryParse(text.slice(i,end)),list=r&&unwrapList(r.value,keys);if(list)return {list};
  const next=text.slice(end).search(/[[{]/);i=next<0?-1:end+next;}
 return {};
}
// `keys` names the object fields that may wrap the list ({"candidates":[...]}).
export function parseCandidates(content,keys=CANDIDATE_KEYS){
 if(Array.isArray(content))return safe(content);
 if(typeof content!=='string')throw Error('모델 응답 형식 오류: 텍스트 응답이 아닙니다. 다시 시도하세요.');
 if(new TextEncoder().encode(content).byteLength>MAX_RESPONSE_BYTES)throw Error('크기 제한 2MB');
 const whole=tryParse(content.trim());
 if(whole){const list=unwrapList(whole.value,keys);if(list)return list;throw parseFail(content);}
 let text=content.trim().replace(/^(\s*<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\2>)+/i,'').trim();
 let found=locate(text,keys);
 // Reasoning leaked without its opening tag: only when the response does not itself
 // start with JSON or a fence, retry after the stray closing tag.
 if(!found.list&&!/^[[{`]/.test(text)){const stray=text.search(/<\/(think|thinking|reasoning)>/i);if(stray>=0)found=locate(text.slice(text.indexOf('>',stray)+1).trim(),keys);}
 if(found.list)return found.list;
 throw parseFail(content);
}
// Per-item normalization of model candidates. Common model variations are accepted;
// anything still unusable is skipped with a reason instead of failing the whole batch.
const layerAlias=new Map();
for(const k of layers){const one=k==='wiki'?'wikis':k.replace(/s$/,'');for(const a of [k,one,layerNames[k],layerNames[k].replace(/\s+/g,'')])layerAlias.set(a.toLowerCase(),k);}
export const textKeys=['text','content','summary','memory'];
const scalar=v=>typeof v==='string'?v.trim():typeof v==='number'&&Number.isFinite(v)||typeof v==='boolean'?String(v):undefined;
const shown=v=>{const t=typeof v==='string'?v:JSON.stringify(v);return t.length>30?t.slice(0,30)+'…':t;};
export function normalizeCandidate(x){
 if(!x||typeof x!=='object'||Array.isArray(x))return {error:'객체가 아님'};
 if(x.layer===undefined||x.layer===null||x.layer==='')return {error:'필드 layer 누락'};
 const name=scalar(x.layer),layer=name===undefined?undefined:layerAlias.get(name.toLowerCase().replace(/\s+/g,' '))||layerAlias.get(name.toLowerCase().replace(/\s+/g,''));
 if(!layer)return {error:'필드 layer 값 '+shown(x.layer)+' 인식 불가'};
 const key=textKeys.find(k=>x[k]!==undefined&&x[k]!==null);
 if(!key)return {error:'필드 text 누락'};
 const text=scalar(x[key]);
 if(text===undefined)return {error:'필드 '+key+' 형식 오류(문자열 아님)'};
 if(!text)return {error:'필드 '+key+' 비어 있음'};
 if(text.length>20000)return {error:'필드 '+key+' 20,000자 초과'};
 const scope=scalar(x.scope)?.toLowerCase();
 return {item:{layer,text,scope:['public','unknown'].includes(scope)?scope:'unknown'}};
}
export function normalizeCandidates(list){
 const items=[],skipped=[];
 (Array.isArray(list)?list:[]).forEach((x,i)=>{const r=normalizeCandidate(x);if(r.item)items.push(r.item);else skipped.push({index:i,reason:r.error});});
 return {items,skipped,total:Array.isArray(list)?list.length:0};
}
export const skippedNotice=n=>n.skipped.length?n.total+'개 중 '+n.skipped.length+'개 형식 오류로 제외(예: '+(n.skipped[0].index+1)+'번째 항목 '+n.skipped[0].reason+')':'';
export function item(x){
 if(!x||!layers.includes(x.layer)||typeof x.text!=='string'||x.text.length>20000||typeof x.id!=='string'||!x.id||x.id.length>120) throw Error('항목 형식 오류');
 if(!Array.isArray(x.evidence||[])||!Array.isArray(x.knownBy||[])||(x.evidence||[]).some(e=>!e||typeof e.id!=='string'||!Number.isInteger(e.index)||typeof e.fingerprint!=='string'))throw Error('근거 형식 오류');
 if(x.status!==undefined&&!['active','completed','cancelled'].includes(x.status))throw Error('상태 형식 오류');
 return {...x,scope:x.scope||'unknown',status:x.status||'active',evidence:x.evidence||[],knownBy:x.knownBy||[]};
}
export const publicItems=s=>s.items.filter(x=>x.scope==='public'&&!x.knownBy?.length&&!x.audience&&!x.condition&&!x.importedScope&&!x.branchHold&&!x.hold&&!x.review&&!x.resumeRequired&&!['cancelled','completed'].includes(x.status));
// Why a candidate needs a one-by-one look. Bulk approval leaves these out; the scope a
// model claimed is never one of the inputs (analysis stores every candidate as unknown).
export function candidateRisks(x){
 const r=[];
 if(x.targetId)r.push('기존 항목 변경');
 if(x.hold||x.branchHold||x.importedScope||x.resumeRequired)r.push('보류');
 if(x.review)r.push('근거 재검토');
 if(x.knownBy?.length||x.audience||x.condition||['secret','character'].includes(x.scope))r.push('비밀·인물 제한');
 if(x.duplicate)r.push('중복 의심');
 if(['completed','cancelled'].includes(x.status))r.push('완료·취소 상태');
 return r;
}
export const selectSafeCandidates=items=>items.filter(x=>!candidateRisks(x).length).map(x=>x.id);
export function validate(s){
 if(s.version!==1||!Array.isArray(s.items)||!Array.isArray(s.candidates)) throw Error('버전/형식 오류');
 s.items.forEach(item);s.candidates.forEach(item);
 if(new Set(s.items.map(x=>x.id)).size!==s.items.length)throw Error('중복 ID');
 if([...s.items,...s.candidates].filter(x=>x.layer==='elements').length>400||s.candidates.filter(x=>x.layer==='wiki').length>40||s.items.length+s.candidates.length>2000)throw Error('항목 한도 초과');
 return s;
}
function disclosure(old,v,c){
 if(v.scope==='public'&&(!old||(['completed','cancelled'].includes(old.status)&&v.status==='active'))&&c.confirmPublic!==true)throw Error('공개 범위 확대: 명시 확인 필요');
 if(old&&((old.scope!=='public'&&v.scope==='public')||['knownBy','audience','condition','importedScope','branchHold','hold','review','resumeRequired'].some(k=>JSON.stringify(old[k]||null)!==JSON.stringify(v[k]||null)&&(Array.isArray(old[k])?old[k].length:old[k])))&&c.confirmPublic!==true)throw Error('공개 범위 확대: 명시 확인 필요');
}
export function apply(state,command){
 const s=clone(state),c=safe(command);
 const before={items:clone(s.items),candidates:clone(s.candidates)};
 if(c.type==='put') {const v=item(c.item);if(s.candidates.some(x=>x.id===v.id))throw Error('후보는 명시 승인 전 저장할 수 없음'); const i=s.items.findIndex(x=>x.id===v.id); disclosure(s.items[i],v,c);if(i<0)s.items.push(v);else s.items[i]=v;}

 else if(c.type==='delete'){s.items=s.items.filter(x=>!c.ids.includes(x.id));s.candidates=s.candidates.filter(x=>!c.ids.includes(x.id));}
 else if(c.type==='editCandidate'){const i=s.candidates.findIndex(x=>x.id===c.item.id);if(i<0)throw Error('후보 없음');const v=item(c.item);disclosure(s.candidates[i],v,c);s.candidates[i]=v;}
 else if(c.type==='hold'){for(const x of [...s.items,...s.candidates])if(c.ids.includes(x.id))x.hold=true;}
 else if(c.type==='propose'){for(const x of c.items){const v=item(x);if(!s.candidates.some(y=>y.id===v.id)&&!s.items.some(y=>y.sourceCandidateId===v.id))s.candidates.push(v);}}
 else if(c.type==='approve'){
  // The user's approval is the scope decision: 'public' (모두가 아는 기억, injected)
  // still passes the disclosure gate and so needs confirmPublic; 'unknown' keeps the
  // memory private (saved, never injected). Without scope the candidate's own is kept.
  if(c.scope!==undefined&&!['public','unknown'].includes(c.scope))throw Error('승인 범위 형식 오류');
  if(!Array.isArray(c.ids))throw Error('승인 대상 형식 오류');
  for(const id of c.ids){const v=s.candidates.find(x=>x.id===id);if(!v)continue;
   const old=s.items.find(x=>x.id===v.targetId);
   if(old?.locked)throw Error('위키 잠금: 먼저 수동 해제');
   if(v.hold||v.branchHold||v.resumeRequired||v.review||v.importedScope)throw Error('보류 후보');
   const restricted=['secret','character'].includes(v.scope);
   if(c.scope==='public'&&restricted)throw Error('비밀·인물 제한 후보는 공개로 승인할 수 없음: 편집에서 범위를 확인하세요');
   if(c.scope==='public'&&c.ids.length>1&&candidateRisks(v).length)throw Error('일괄 공개 승인에 직접 확인이 필요한 후보가 포함됨: 하나씩 확인하세요');
   const scope=c.scope==='public'?'public':c.scope==='unknown'?(restricted?v.scope:'unknown'):v.scope;
   if(old && v.baseText!==old.text)throw Error('위키 원문 충돌');
   if(old && (!publicItems({items:[old]}).length||!publicItems({items:[{...v,scope}]}).length))throw Error('비공개 위키 병합 금지');
   const next={...v,scope,id:old?.id||v.id,sourceCandidateId:id};
   disclosure(old,next,c);
   if(old)s.items[s.items.indexOf(old)]=next;else if(!s.items.some(x=>x.sourceCandidateId===id))s.items.push(next);
   s.candidates=s.candidates.filter(x=>x.id!==id);
  }
 }
 else if(c.type==='healthChanges'){
  // Internal only (the service builds it from stored check proposals after a
  // conflict check). Never deletes and never widens scope: text rewrite, completion
  // of a promise/flow, or archive as hold (injection stops, the memory stays).
  for(const ch of c.changes){const x=s.items.find(y=>y.id===ch.targetId);if(!x)throw Error('점검 대상 없음');
   if(ch.action==='update'){if(typeof ch.text!=='string'||!ch.text.trim()||ch.text.length>20000)throw Error('점검 변경 형식 오류');x.text=ch.text;}
   else if(ch.action==='complete'){if(!lifecycleLayers.includes(x.layer))throw Error('완료는 약속·진행 흐름에만');x.status='completed';}
   else if(ch.action==='archive')x.hold=true;
   else throw Error('점검 변경 형식 오류');
  }
 }
 else if(c.type==='import'){const incoming=validate(safe(c.data));s.items=incoming.items.map(x=>({...item(x),importedScope:true,branchHold:true}));s.candidates=incoming.candidates.map(x=>({...item(x),importedScope:true,branchHold:true}));}
 else if(c.type==='undo'){const prior=s.undo.pop();if(!prior)throw Error('되돌릴 기록 없음');s.items=prior.items;s.candidates=prior.candidates;s.revision++;return validate(s);}
 else throw Error('알 수 없는 작업');
 s.undo=[...s.undo,before].slice(-20);s.revision++;return validate(s);
}
export async function fingerprint(text){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return 'sha256:'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');}
const matches=(m,value)=>!!m&&(m.digest===value||m.content===value);
const hashed=messages=>Promise.all(messages.map(async m=>({...m,digest:await fingerprint(m.content)})));
export async function review(state,messages){const s=clone(state),ms=await hashed(messages);for(const x of s.items)x.review=x.evidence.some(e=>!ms.some(m=>m.id===e.id&&matches(m,e.fingerprint)));return s;}
export async function inherit(parent,pm,cm,cutId,createdAt){
 [pm,cm]=await Promise.all([hashed(pm),hashed(cm)]);
 const s=empty(),cut=pm.findIndex(m=>m.id===cutId);
 s.items=clone(parent.items).map(x=>{
  let valid=cut>=0&&x.evidence.length>0&&Number.isSafeInteger(createdAt)&&Number.isSafeInteger(x.lastChangedAt)&&x.lastChangedAt<createdAt*1000;
  x.evidence=x.evidence.map(e=>{const p=pm[e.index],c=cm[e.index];if(e.index>cut||!p||!c||p.id!==e.id||!matches(p,e.fingerprint)||!matches(c,e.fingerprint)){valid=false;return e;}return {...e,id:c.id,fingerprint:c.digest};});
  x.branchHold=!valid||!Number.isInteger(x.lastChangeIndex)||x.lastChangeIndex>cut||!x.changeEvidence||!cm[x.lastChangeIndex]||!pm[x.lastChangeIndex]||pm[x.lastChangeIndex].id!==x.changeEvidence.id||!matches(pm[x.lastChangeIndex],x.changeEvidence.fingerprint)||!matches(cm[x.lastChangeIndex],x.changeEvidence.fingerprint)||!!x.branchHold;if(!x.branchHold)x.changeEvidence={id:cm[x.lastChangeIndex].id,fingerprint:cm[x.lastChangeIndex].digest};return x;
 });return s;
}
// Source scope for analysis. Message numbers are 1-based positions in the full chat
// as the host orders it; hidden messages keep their slot but are never analyzed.
// The panel only knows the message count and hidden positions, never bodies: it shows
// a summary with sourceSummary(), and the service resolves the same scope against the
// host messages with selectSource() when the user presses analyze.
export const MAX_INPUT_CHARS=60000;
export const MAX_RANGES=20;
export const DEFAULT_RECENT=20;
const int=x=>x===''||x===null||x===undefined?NaN:Number(x);
export function rangeStatus(range,total){
 const [start,end]=[range?.start,range?.end].map(int);
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<1)return {ok:false,warning:'시작·끝은 1 이상의 정수로 입력하세요.'};
 if(start>end)return {ok:false,start,end,warning:'시작 번호가 끝 번호보다 큽니다.'};
 if(!(total>0))return {ok:false,start,end,warning:'대화가 아직 없습니다.'};
 if(start>total)return {ok:false,start,end,warning:'이 범위는 채팅 기록 밖입니다. (전체 '+total+'개)'};
 if(end>total)return {ok:true,start,end:total,warning:'끝 번호가 채팅 기록 밖이라 '+start+' - '+total+'까지만 분석합니다.'};
 return {ok:true,start,end};
}
// Validates, clamps and merges a scope into sorted, disjoint [start,end] spans.
// {ok:false,error} for anything that cannot be analyzed; warnings for adjustments.
export function resolveScope(scope,total){
 if(!(Number.isSafeInteger(total)&&total>0))return {ok:false,error:'대화가 아직 없습니다.'};
 if(scope?.scope==='last'){
  const n=int(scope.n);
  if(!Number.isSafeInteger(n)||n<1)return {ok:false,error:'최근 개수는 1 이상의 정수로 입력하세요.'};
  return {ok:true,spans:[[Math.max(1,total-n+1),total]],warnings:n>total?['대화가 '+total+'개뿐이라 전체를 분석합니다.']:[]};
 }
 if(scope?.scope!=='range')return {ok:false,error:'분석 범위 방식을 고르세요.'};
 const ranges=Array.isArray(scope.ranges)?scope.ranges:[];
 if(!ranges.length)return {ok:false,error:'범위를 하나 이상 추가하세요.'};
 if(ranges.length>MAX_RANGES)return {ok:false,error:'범위는 '+MAX_RANGES+'개까지 넣을 수 있습니다.'};
 const warnings=[],raw=[];
 for(const [k,r] of ranges.entries()){
  const s=rangeStatus(r,total);
  if(!s.ok)return {ok:false,error:'범위 '+(k+1)+': '+s.warning};
  if(s.warning)warnings.push('범위 '+(k+1)+': '+s.warning);
  raw.push([s.start,s.end]);
 }
 // Only overlapping ranges are merged; adjacent ones (10–20, 21–30) stay separate,
 // since each span is analyzed with its own model call.
 raw.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);const spans=[];
 for(const x of raw){const last=spans.at(-1);if(last&&x[0]<=last[1]){warnings.includes('겹치는 범위는 하나로 합쳤습니다.')||warnings.push('겹치는 범위는 하나로 합쳤습니다.');last[1]=Math.max(last[1],x[1]);}else spans.push([...x]);}
 return {ok:true,spans,warnings};
}
// Pre-fill for '+ 범위 추가', following Marinara's batch summary ranges: the new row
// starts right after the previous row and keeps its length, clamped to the chat.
// null (button disabled) when the previous row is unusable or already reaches the end.
export function nextRange(prev,total){
 const [a,b]=[prev?.start,prev?.end].map(int);
 if(!(Number.isSafeInteger(total)&&total>0)||!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<1||b<1)return null;
 const lo=Math.min(a,b),hi=Math.max(a,b);
 if(hi>total)return null;
 const start=hi+1;if(start>total)return null;
 return {start:String(start),end:String(Math.min(total,start+(hi-lo)))};
}
export const spanLabel=spans=>'대화 '+spans.map(([a,b])=>a===b?String(a):a+'–'+b).join(', ');
// Panel summary from the count only: "대화 120–141 (22개)", hidden positions excluded.
export function sourceSummary(scope,total,hidden=[]){
 const r=resolveScope(scope,total);if(!r.ok)return r;
 const skip=new Set(hidden),inSpan=n=>r.spans.some(([a,b])=>n>=a&&n<=b);
 const size=r.spans.reduce((n,[a,b])=>n+b-a+1,0),skipped=[...skip].filter(inSpan).length,count=size-skipped;
 if(!count)return {ok:false,error:'고른 범위의 메시지가 모두 숨김이라 분석할 것이 없습니다.'};
 return {...r,count,skipped,text:spanLabel(r.spans)+' ('+count+'개)'+(skipped?' · 숨김 '+skipped+'개 제외':'')};
}
// Service side: the same scope resolved against the host's current messages.
export function selectSource(messages,scope){
 const {total,hidden}=countOf(messages),s=sourceSummary(scope,total,hidden);if(!s.ok)throw Error(s.error);
 const picked=messages.map((m,index)=>({m,index})).filter(({m,index})=>!m?.extra?.hidden&&s.spans.some(([a,b])=>index+1>=a&&index+1<=b));
 return {...s,picked};
}
export const countOf=messages=>({total:messages.length,hidden:messages.flatMap((m,i)=>m?.extra?.hidden?[i+1]:[])});
// Analysis input: a time-zone line, then each message prefixed with its host send time
// (Lumiverse 1.2.5 Message.send_date, unix seconds; millisecond values are tolerated).
// The service builds the model input with it and applies MAX_INPUT_CHARS to the result.
export function validTimeZone(zone){
 if(typeof zone!=='string'||!/^[A-Za-z0-9_+\-\/]{1,64}$/.test(zone))return null;
 try{new Intl.DateTimeFormat('en-US',{timeZone:zone});return zone;}catch{return null;}
}
export const localTimeZone=()=>{try{return validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);}catch{return null;}};
const formatters=new Map();
export function sentStamp(m,zone){
 const raw=Number(m?.send_date??m?.created_at);
 if(!Number.isFinite(raw)||raw<=0)return null;
 const ms=raw>1e11?raw:raw*1000,tz=validTimeZone(zone)||'UTC';
 if(!formatters.has(tz))formatters.set(tz,new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}));
 let p;try{p=Object.fromEntries(formatters.get(tz).formatToParts(new Date(ms)).map(x=>[x.type,x.value]));}catch{return null;}
 return p.year+'-'+p.month+'-'+p.day+' '+(p.hour==='24'?'00':p.hour)+':'+p.minute;
}
export function sourceInput(messages,zone){
 if(!messages.length)return '';
 const tz=validTimeZone(zone),header='[메시지 전송 시각 기준: '+(tz||'UTC (사용자 시간대 미확인)')+']';
 return [header,...messages.map(m=>{const t=sentStamp(m,tz);return (t?'[전송 '+t+'] ':'[전송 시각 미상] ')+String(m.content??'');})].join('\n\n');
}
// Lumiverse's own chat summary (Loom Summary): one text per chat, stored by the host in
// chat.metadata.loom_summary (read through chats.get, the existing `chats` permission).
// Reference only, never a memory: it goes after the raw input, only into the room the
// raw input leaves under MAX_INPUT_CHARS, capped at LOOM_CAP and cut from the start so
// the most recent part stays. Untrusted text: non-strings and anything over 2MB read as
// no summary, control characters are dropped and block markers removed so it can never
// close its own block.
export const LOOM_CAP=8000,LOOM_MIN=200;
const LOOM_HEAD='\n\n[LUMIVERSE SUMMARY]\n',LOOM_TAIL='\n[/LUMIVERSE SUMMARY]',LOOM_CUT='…(앞부분 생략)\n';
export function loomText(chat){
 const v=chat?.metadata?.loom_summary;
 if(typeof v!=='string'||new TextEncoder().encode(v).byteLength>2000000)return '';
 return v.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/\[\s*\/?\s*LUMIVERSE SUMMARY[^\]\n]*\]/gi,'').trim();
}
export function loomBlock(text,room=Infinity){
 if(!text)return {text:'',chars:0};
 const fit=Math.min(LOOM_CAP,room-LOOM_HEAD.length-LOOM_TAIL.length);
 if(text.length<=fit)return {text:LOOM_HEAD+text+LOOM_TAIL,chars:text.length};
 const keep=fit-LOOM_CUT.length;
 if(keep<LOOM_MIN)return {text:'',chars:0,omitted:true};
 const body=text.slice(-keep).replace(/^[\udc00-\udfff]/,'');
 return {text:LOOM_HEAD+LOOM_CUT+body+LOOM_TAIL,chars:body.length,truncated:true};
}
// Shown after the scope in the panel and in notices; empty when the option is off.
export const loomLabel=(on,b)=>!on?'':b.chars?'루미버스 요약 참고 ('+b.chars.toLocaleString('en-US')+'자'+(b.truncated?', 앞부분 생략':'')+')':b.omitted?'루미버스 요약 생략 (원문이 한도에 가까움)':'요약 없음';
// Memory check (기억 점검). The model sees eligible memories under short aliases (M1,
// M2, …) and may only propose update / complete / archive for those aliases; anything
// else is skipped with a reason. Each proposal keeps a snapshot of its target so a
// memory edited after the check is reported as a conflict instead of being overwritten.
export const MAX_PROPOSALS=30;
export const healthEligible=x=>!x.knownBy?.length&&!x.audience&&!x.condition&&!['secret','character'].includes(x.scope)&&!x.hold;
export const healthBase=x=>({text:x.text,status:x.status||'active',hold:!!x.hold,scope:x.scope||'unknown'});
export const sameBase=(x,base)=>!!x&&!!base&&JSON.stringify(healthBase(x))===JSON.stringify(base);
const actionAlias={update:'update',edit:'update',merge:'update',rewrite:'update',complete:'complete',completed:'complete',done:'complete',archive:'archive',archived:'archive',keep:'keep',none:'keep',add:'add',create:'add',delete:'delete',remove:'delete'};
export function normalizeProposals(list,targets){
 const items=[],skipped=[],seen=new Set(),rows=Array.isArray(list)?list:[];
 rows.forEach((x,index)=>{
  const fail=reason=>{skipped.push({index,reason});};
  if(!x||typeof x!=='object'||Array.isArray(x))return fail('객체가 아님');
  const name=scalar(x.action),action=name===undefined?undefined:actionAlias[name.toLowerCase()];
  if(!action)return fail('필드 action 값 '+shown(x.action??'')+' 인식 불가');
  if(action==='keep')return;
  if(action==='add')return fail('새 기억 추가는 점검에서 받지 않음');
  if(action==='delete')return fail('삭제는 점검에서 받지 않음');
  const ref=scalar(x.targetId??x.target??x.id),t=ref===undefined?undefined:targets.get(ref.toUpperCase());
  if(!t)return fail('알 수 없는 대상 '+shown(x.targetId??x.target??x.id??''));
  if(seen.has(t.id))return fail('같은 대상에 제안이 여러 개');
  if(action==='complete'&&!lifecycleLayers.includes(t.layer))return fail('완료는 약속·진행 흐름에만');
  if(action==='complete'&&(t.status||'active')!=='active')return fail('이미 끝난 항목');
  let text;
  if(action==='update'){
   const key=textKeys.find(k=>x[k]!==undefined&&x[k]!==null);text=key===undefined?undefined:scalar(x[key]);
   if(!text)return fail('필드 text 누락');if(text.length>20000)return fail('필드 text 20,000자 초과');if(text===t.text)return fail('변경 없음');
  }
  if(items.length>=MAX_PROPOSALS)return fail('제안 '+MAX_PROPOSALS+'개 초과');
  seen.add(t.id);items.push({action,targetId:t.id,...(text!==undefined?{text}:{}),reason:(scalar(x.reason)||'').slice(0,500)});
 });
 return {items,skipped,total:rows.length};
}
// Splits chosen proposals into changes that still match their snapshot and conflicts.
export function healthPlan(state,proposals){
 const changes=[],conflicts=[];
 for(const p of proposals){const x=state.items.find(y=>y.id===p.targetId);
  if(!x||!healthEligible(x)||!sameBase(x,p.base))conflicts.push(p);else changes.push({targetId:p.targetId,action:p.action,...(p.action==='update'?{text:p.text}:{})});}
 return {changes,conflicts};
}
// Always-on diagnostics, computed in the panel without a model call. Keyed grouping
// only (no pairwise comparison), so it stays cheap with hundreds of memories.
export const LONG_TEXT=1500,NEAR_PREFIX=16;
const datePrefix=/^\s*\[[^\]\n]{1,80}\]/;
export const hasDatePrefix=t=>datePrefix.test(String(t||''));
const plain=t=>String(t||'').replace(datePrefix,'').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');
export function diagnose(state,auto){
 const items=state?.items||[],rows=[];
 const add=(key,text,list,tone='warn')=>{if(list.length)rows.push({key,text,tone,ids:list.map(x=>x.id)});};
 const groups=(keyOf)=>{const m=new Map();for(const x of items){const k=keyOf(x);if(!k)continue;if(!m.has(k))m.set(k,[]);m.get(k).push(x);}return [...m.values()].filter(g=>g.length>1);};
 const exact=groups(x=>{const p=plain(x.text);return p&&x.layer+'\u0000'+p;}),exactIds=new Set(exact.flat().map(x=>x.id));
 add('exact','내용이 같은 기억 '+exact.flat().length+'개 ('+exact.length+'묶음)',exact.flat());
 const near=groups(x=>{const p=plain(x.text);return p.length>=NEAR_PREFIX&&!exactIds.has(x.id)&&x.layer+'\u0000'+p.slice(0,NEAR_PREFIX);}).flat();
 add('near','앞부분이 같은 기억 '+near.length+'개 (중복 의심)',near,'muted');
 add('empty','내용이 빈 기억 '+items.filter(x=>!String(x.text||'').trim()).length+'개',items.filter(x=>!String(x.text||'').trim()));
 const long=items.filter(x=>String(x.text||'').length>LONG_TEXT);
 add('long',LONG_TEXT.toLocaleString('en-US')+'자가 넘는 긴 기억 '+long.length+'개',long,'muted');
 const undated=items.filter(x=>String(x.text||'').trim()&&!hasDatePrefix(x.text));
 add('undated','날짜 표기([…])로 시작하지 않는 기억 '+undated.length+'개',undated,'muted');
 const priv=items.filter(x=>(x.scope||'unknown')==='unknown'&&!['completed','cancelled'].includes(x.status));
 add('private','승인했지만 비공개라 주입되지 않는 기억 '+priv.length+'개 · 펼쳐서 ‘모두가 아는 기억으로’를 누르면 다음 답변부터 들어갑니다',priv);
 const held=items.filter(x=>x.scope==='public'&&(x.hold||x.branchHold||x.importedScope||x.review||x.resumeRequired));
 add('held','공개지만 보류·재검토로 주입이 멈춘 기억 '+held.length+'개',held,'muted');
 const pending=state?.candidates?.length||0;
 if(pending)rows.push({key:'pending',text:'검토 대기 후보 '+pending+'개 · 승인 전에는 주입되지 않습니다',tone:'muted',ids:[]});
 if(auto?.last&&auto.last.ok===false)rows.push({key:'auto',text:'자동 분석 마지막 실행 실패: '+String(auto.last.error||'알 수 없는 오류'),tone:'warn',ids:[]});
 return rows;
}

// Original Marinara memory vault 2.1.1 CSS; MIT notice in NOTICE.
export const vaultStyle = "/* 기억 보관함 v2.0.0 · 전역 테마 하나(리본 라일락·스토리 로즈·아카이브 그린·마리나라 따르기)가 보관함과 이야기 위키를 함께 칠한다 */\n#mmc-root-v1,.mmc-launcher,.mmc-toast{--fs:1;--t-2xs:calc(10.5px*var(--fs));--t-xs:calc(11.5px*var(--fs));--t-sm:calc(12.5px*var(--fs));--t-md:calc(13.5px*var(--fs));--t-lg:calc(15px*var(--fs));--t-xl:calc(17px*var(--fs));--t-2xl:calc(22px*var(--fs));--t-3xl:calc(28px*var(--fs));--mv-font:var(--font-y2k,var(--font-user,-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"Apple SD Gothic Neo\",\"Noto Sans KR\",\"Malgun Gothic\",sans-serif));--mv-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--mv-r:12px;--mv-r-sm:8px;font-family:var(--mv-font);}\n#mmc-root-v1[data-mmc-font-size=\"large\"],.mmc-toast[data-mmc-font-size=\"large\"]{--fs:1.1}\n#mmc-root-v1[data-mmc-font-size=\"xlarge\"],.mmc-toast[data-mmc-font-size=\"xlarge\"]{--fs:1.2}\n#mmc-root-v1,.mmc-launcher,.mmc-toast,#mmc-root-v1[data-mmc-theme=\"ribbon\"],.mmc-launcher[data-mmc-theme=\"ribbon\"],.mmc-toast[data-mmc-theme=\"ribbon\"]{--mv-bg:#f4f3f9;--mv-paper:#ffffff;--mv-paper-2:#f9f8fd;--mv-sunk:#efeef6;--mv-ink:#23222e;--mv-ink-2:#4f4e63;--mv-muted:#7c7b93;--mv-line:#e4e2ee;--mv-line-2:#cfcce0;--mv-accent:#5b5fb5;--mv-accent-ink:#ffffff;--mv-accent-soft:#ebebf9;--mv-accent-2:#b0679a;--mv-ok:#2e8a62;--mv-warn:#b7791f;--mv-danger:#c0474f;--mv-hold:#8a7f5a;--mv-wiki-link:#4450c4;--mv-wiki-missing:#cc3f3a;--mv-wiki-head:#5b5fb5;--mv-wiki-head-ink:#ffffff;--mv-wiki-box:#f6f5fb;--mv-wiki-rule:#d6d4e6;--mv-scrim:rgba(35,34,46,.42);--mv-shadow:0 30px 80px rgba(35,34,46,.28);}\n#mmc-root-v1[data-mmc-theme=\"rose\"],.mmc-launcher[data-mmc-theme=\"rose\"],.mmc-toast[data-mmc-theme=\"rose\"]{--mv-bg:#f7f1f0;--mv-paper:#fffdfc;--mv-paper-2:#fbf6f5;--mv-sunk:#f2e9e8;--mv-ink:#2c2224;--mv-ink-2:#5d4a4e;--mv-muted:#8f7c82;--mv-line:#ecdfdf;--mv-line-2:#dac7c9;--mv-accent:#a14c64;--mv-accent-ink:#ffffff;--mv-accent-soft:#f6e5ea;--mv-accent-2:#7c6a4f;--mv-ok:#3d7f5f;--mv-warn:#aa7424;--mv-danger:#b8404a;--mv-hold:#8d7a55;--mv-wiki-link:#a53f5c;--mv-wiki-missing:#c4382f;--mv-wiki-head:#7d3c4e;--mv-wiki-head-ink:#ffffff;--mv-wiki-box:#faf3f3;--mv-wiki-rule:#e2d1d3;--mv-scrim:rgba(44,34,36,.42);--mv-shadow:0 30px 80px rgba(44,34,36,.28);}\n#mmc-root-v1[data-mmc-theme=\"green\"],.mmc-launcher[data-mmc-theme=\"green\"],.mmc-toast[data-mmc-theme=\"green\"]{--mv-bg:#f2f5f4;--mv-paper:#ffffff;--mv-paper-2:#f8faf9;--mv-sunk:#eaf0ee;--mv-ink:#1f2523;--mv-ink-2:#46514e;--mv-muted:#76837f;--mv-line:#dde5e2;--mv-line-2:#c6d2ce;--mv-accent:#00897b;--mv-accent-ink:#ffffff;--mv-accent-soft:#dcf2ef;--mv-accent-2:#0f7fbd;--mv-ok:#1f8a57;--mv-warn:#b7791f;--mv-danger:#d0453f;--mv-hold:#7f8663;--mv-wiki-link:#0f7fbd;--mv-wiki-missing:#d0453f;--mv-wiki-head:#00a495;--mv-wiki-head-ink:#ffffff;--mv-wiki-box:#f5f7f7;--mv-wiki-rule:#ccd6d3;--mv-scrim:rgba(31,37,35,.42);--mv-shadow:0 30px 80px rgba(31,37,35,.26);}\n#mmc-root-v1[data-mmc-theme=\"marinara\"],.mmc-launcher[data-mmc-theme=\"marinara\"],.mmc-toast[data-mmc-theme=\"marinara\"]{--mv-bg:var(--background,#faf8ff);--mv-paper:var(--card,#ffffff);--mv-paper-2:color-mix(in srgb,var(--card,#fff) 94%,var(--foreground,#1a1025));--mv-sunk:color-mix(in srgb,var(--background,#faf8ff) 90%,var(--foreground,#1a1025));--mv-ink:var(--foreground,#1a1025);--mv-ink-2:color-mix(in srgb,var(--foreground,#1a1025) 80%,var(--background,#fff));--mv-muted:var(--muted-foreground,#7a64a0);--mv-line:var(--border,color-mix(in srgb,var(--foreground,#1a1025) 14%,transparent));--mv-line-2:color-mix(in srgb,var(--border,#ddd) 65%,var(--foreground,#1a1025));--mv-accent:var(--primary,#8b6cf0);--mv-accent-ink:var(--primary-foreground,#ffffff);--mv-accent-soft:color-mix(in srgb,var(--primary,#8b6cf0) 15%,var(--card,#fff));--mv-accent-2:color-mix(in srgb,var(--primary,#8b6cf0) 45%,#d0679f);--mv-ok:var(--success,#3f9a6e);--mv-warn:#c08a2e;--mv-danger:var(--destructive,#d9534f);--mv-hold:#9a8a5f;--mv-wiki-link:var(--primary,#8b6cf0);--mv-wiki-missing:var(--destructive,#d9534f);--mv-wiki-head:color-mix(in srgb,var(--primary,#8b6cf0) 42%,var(--card,#fff));--mv-wiki-head-ink:var(--foreground,#1a1025);--mv-wiki-box:color-mix(in srgb,var(--card,#fff) 94%,var(--foreground,#1a1025));--mv-wiki-rule:var(--border,#ddd);--mv-scrim:color-mix(in srgb,var(--background,#000) 55%,transparent);--mv-shadow:0 30px 80px rgba(0,0,0,.35);}\n#mmc-root-v1[hidden]{display:none!important}\n#mmc-root-v1 [hidden]{display:none!important}\n#mmc-root-v1 *,#mmc-root-v1 *::before,#mmc-root-v1 *::after,.mmc-launcher *{box-sizing:border-box}\n#mmc-root-v1 button,#mmc-root-v1 input,#mmc-root-v1 select,#mmc-root-v1 textarea{font-family:inherit;letter-spacing:normal}\n#mmc-root-v1 button{cursor:pointer;-webkit-tap-highlight-color:transparent}\n#mmc-root-v1 button:disabled{cursor:not-allowed}\n#mmc-root-v1 .mmc-svg,.mmc-launcher .mmc-svg{display:block!important;overflow:visible!important;fill:none!important;stroke:currentColor!important;stroke-linecap:round!important;stroke-linejoin:round!important;pointer-events:none!important;flex:none;width:18px;height:18px}\n.mmc-launcher{position:fixed;right:0;top:44%;z-index:141;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;width:46px;height:58px;padding:0;border:1px solid color-mix(in srgb,var(--mv-accent) 70%,#000);border-right:0;border-radius:14px 0 0 14px;background:var(--mv-accent);color:var(--mv-accent-ink);box-shadow:-4px 6px 18px rgba(0,0,0,.18);cursor:pointer;font-family:var(--mv-font);overflow:visible}\n.mmc-launcher .mmc-svg{width:20px;height:20px}\n.mmc-launcher span{font-size:10px;font-weight:800;letter-spacing:.04em;line-height:1;writing-mode:horizontal-tb}\n.mmc-launcher:hover{width:50px}\n.mmc-launcher-badge{position:absolute;top:-6px;left:-7px;min-width:19px;height:19px;padding:0 5px;border:2px solid var(--mv-paper);border-radius:999px;background:var(--mv-danger);color:#fff;font:800 10px/15px var(--mv-mono);font-style:normal;text-align:center}\n.mmc-launcher-badge[hidden]{display:none!important}\n.mmc-launcher.has-summary-alert{animation:mmc-nudge 2.4s ease-in-out 2}\n@keyframes mmc-nudge{0%,100%{transform:none}40%{transform:translateX(-4px)}60%{transform:translateX(0)}}\n.mmc-toast{position:fixed;left:50%;bottom:28px;z-index:220;max-width:min(520px,calc(100vw - 32px));transform:translate(-50%,14px);opacity:0;pointer-events:none;padding:10px 16px;border-radius:12px;background:var(--mv-ink);color:var(--mv-paper);font:600 var(--t-sm)/1.45 var(--mv-font);box-shadow:0 10px 30px rgba(0,0,0,.25);transition:opacity .18s,transform .18s}\n.mmc-toast.is-show{opacity:1;transform:translate(-50%,0)}\n.mmc-toast.is-error{background:var(--mv-danger);color:#fff}\n@media(max-width:700px){.mmc-launcher{top:auto;bottom:188px;width:42px;height:52px}\n.mmc-toast{bottom:calc(84px + env(safe-area-inset-bottom))}}\n#mmc-root-v1 .mmc-overlay{position:fixed;inset:0;z-index:170;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--mv-scrim);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}\n#mmc-root-v1 .mmc-shell{position:relative;width:min(1180px,100%);height:min(900px,calc(100dvh - 40px));display:grid;grid-template-rows:auto auto minmax(0,1fr);overflow:hidden;border:1px solid var(--mv-line-2);border-radius:18px;background:var(--mv-bg);color:var(--mv-ink);box-shadow:var(--mv-shadow);font-size:var(--t-md);line-height:1.5}\n#mmc-root-v1 .mmc-bar{display:flex;align-items:center;gap:12px;min-width:0;padding:14px 18px 12px;background:var(--mv-paper)}\n#mmc-root-v1 .mmc-brand{display:flex;align-items:center;gap:11px;min-width:0;flex:none}\n#mmc-root-v1 .mmc-brand-mark{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--mv-accent);color:var(--mv-accent-ink)}\n#mmc-root-v1 .mmc-brand-mark .mmc-svg{width:21px;height:21px}\n#mmc-root-v1 .mmc-brand-text{display:flex;flex-direction:column;line-height:1.15}\n#mmc-root-v1 .mmc-brand-text b{font-size:var(--t-xl);font-weight:800;letter-spacing:-.02em}\n#mmc-root-v1 .mmc-brand-text small{margin-top:3px;color:var(--mv-muted);font:600 var(--t-2xs)/1 var(--mv-mono);letter-spacing:.08em}\n#mmc-root-v1 .mmc-story{display:flex;align-items:center;gap:10px;min-width:0;max-width:340px;margin-left:10px;padding:6px 12px 6px 7px;border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper-2);cursor:pointer}\n#mmc-root-v1 .mmc-story:hover{border-color:var(--mv-line-2)}\n#mmc-root-v1 .mmc-story-icon{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--mv-accent-soft);color:var(--mv-accent);flex:none}\n#mmc-root-v1 .mmc-story-icon .mmc-svg{width:17px;height:17px}\n#mmc-root-v1 .mmc-story-copy{display:flex;flex-direction:column;min-width:0;flex:1}\n#mmc-root-v1 .mmc-story-copy small{color:var(--mv-muted);font-size:var(--t-2xs);line-height:1.2}\n#mmc-root-v1 .mmc-story-copy select{appearance:auto;min-width:0;width:100%;margin:0 0 0 -3px;padding:0;border:0;background:transparent;color:var(--mv-ink);font-size:var(--t-md);font-weight:800;outline:none;cursor:pointer}\n#mmc-root-v1 .mmc-bar-spacer{flex:1}\n#mmc-root-v1 .mmc-sync{display:inline-flex;align-items:center;gap:7px;min-height:32px;padding:0 11px;border:1px solid var(--mv-line);border-radius:999px;background:var(--mv-paper);color:var(--mv-ink-2);font-size:var(--t-xs);font-weight:700;white-space:nowrap}\n#mmc-root-v1 .mmc-sync .mmc-svg{width:14px;height:14px;color:var(--mv-muted)}\n#mmc-root-v1 .mmc-sync:hover{border-color:var(--mv-accent);color:var(--mv-accent)}\n#mmc-root-v1 .mmc-sync-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--mv-line-2);flex:none}\n#mmc-root-v1 .mmc-element-status .mmc-sync-dot{margin-right:6px;vertical-align:0}\n#mmc-root-v1 .mmc-sync.is-ok,#mmc-root-v1 .mmc-sync.is-ok .mmc-svg{color:var(--mv-ok)}\n#mmc-root-v1 .mmc-sync.is-ok{background:color-mix(in srgb,var(--mv-ok) 9%,var(--mv-paper));border-color:color-mix(in srgb,var(--mv-ok) 30%,var(--mv-line))}\n#mmc-root-v1 .mmc-sync.is-ok .mmc-sync-dot,#mmc-root-v1 .mmc-sync-dot.is-ok{background:var(--mv-ok)}\n#mmc-root-v1 .mmc-sync.is-bad{color:var(--mv-danger);border-color:color-mix(in srgb,var(--mv-danger) 40%,var(--mv-line));background:color-mix(in srgb,var(--mv-danger) 8%,var(--mv-paper))}\n#mmc-root-v1 .mmc-sync.is-bad .mmc-sync-dot{background:var(--mv-danger)}\n#mmc-root-v1 .mmc-head-actions{display:flex;gap:4px;flex:none}\n#mmc-root-v1 .mmc-icon-btn{display:grid;place-items:center;width:36px;height:36px;padding:0;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--mv-ink-2)}\n#mmc-root-v1 .mmc-icon-btn:hover{background:var(--mv-sunk);color:var(--mv-ink)}\n#mmc-root-v1 .mmc-icon-btn .mmc-svg{width:19px;height:19px}\n#mmc-root-v1 .mmc-tabs{display:flex;align-items:flex-end;gap:2px;padding:0 14px;border-bottom:1px solid var(--mv-line-2);background:var(--mv-paper);overflow-x:auto;scrollbar-width:none}\n#mmc-root-v1 .mmc-tabs::-webkit-scrollbar{display:none}\n#mmc-root-v1 .mmc-tab{position:relative;display:inline-flex;align-items:center;gap:8px;min-height:44px;margin-bottom:-1px;padding:0 15px;border:1px solid transparent;border-bottom:0;border-radius:12px 12px 0 0;background:transparent;color:var(--mv-muted);font-size:var(--t-md);font-weight:700;white-space:nowrap}\n#mmc-root-v1 .mmc-tab:hover{color:var(--mv-ink)}\n#mmc-root-v1 .mmc-tab .mmc-svg{width:17px;height:17px}\n#mmc-root-v1 .mmc-tab em{min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--mv-sunk);color:var(--mv-ink-2);font:700 var(--t-2xs)/20px var(--mv-mono);font-style:normal;text-align:center}\n#mmc-root-v1 .mmc-tab-short{display:none}\n#mmc-root-v1 .mmc-tab-dot{width:7px;height:7px;border-radius:50%;background:var(--mv-accent-2)}\n#mmc-root-v1 .mmc-tab.is-active{border-color:var(--mv-line-2);background:var(--mv-bg);color:var(--mv-ink)}\n#mmc-root-v1 .mmc-tab.is-active::before{content:\"\";position:absolute;left:12px;right:12px;top:-1px;height:3px;border-radius:0 0 3px 3px;background:var(--mv-accent)}\n#mmc-root-v1 .mmc-tab.is-active em{background:var(--mv-accent);color:var(--mv-accent-ink)}\n#mmc-root-v1 .mmc-tab.is-active .mmc-svg{color:var(--mv-accent)}\n#mmc-root-v1 .mmc-body{min-height:0;overflow:auto;padding:18px 20px 26px;background:var(--mv-bg);overscroll-behavior:contain}\n#mmc-root-v1 .mmc-shell[data-tab=\"wiki\"] .mmc-body{padding:0;overflow:hidden}\n#mmc-root-v1 .mmc-card{border:1px solid var(--mv-line);border-radius:var(--mv-r);background:var(--mv-paper)}\n#mmc-root-v1 .mmc-card-head{display:flex;align-items:center;gap:8px;padding:14px 16px 10px}\n#mmc-root-v1 .mmc-card-head b{font-size:var(--t-lg);font-weight:800}\n#mmc-root-v1 .mmc-count{min-width:22px;height:22px;padding:0 7px;border-radius:999px;background:var(--mv-accent-soft);color:var(--mv-accent);font:800 var(--t-xs)/22px var(--mv-mono);font-style:normal;text-align:center}\n#mmc-root-v1 .mmc-eyebrow{display:block;color:var(--mv-muted);font-size:var(--t-xs);font-weight:700;letter-spacing:.02em}\n#mmc-root-v1 .mmc-kicker{display:block;color:var(--mv-muted);font:700 var(--t-2xs)/1.3 var(--mv-mono);letter-spacing:.08em}\n#mmc-root-v1 .mmc-muted{color:var(--mv-muted)}\n#mmc-root-v1 .mmc-label{display:block;margin-bottom:6px;color:var(--mv-muted);font-size:var(--t-xs);font-weight:800;letter-spacing:.02em}\n#mmc-root-v1 .mmc-pill{display:inline-flex;align-items:center;min-height:28px;padding:0 12px;border-radius:999px;background:var(--mv-sunk);color:var(--mv-ink-2);font-size:var(--t-xs);font-weight:800;white-space:nowrap}\n#mmc-root-v1 .mmc-pill.is-ok{background:color-mix(in srgb,var(--mv-ok) 13%,var(--mv-paper));color:var(--mv-ok)}\n#mmc-root-v1 .mmc-pill.is-bad{background:color-mix(in srgb,var(--mv-danger) 12%,var(--mv-paper));color:var(--mv-danger)}\n#mmc-root-v1 .mmc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:0 14px;border:1px solid var(--mv-line-2);border-radius:10px;background:var(--mv-paper);color:var(--mv-ink);font-size:var(--t-sm);font-weight:700;line-height:1.2;white-space:nowrap;text-decoration:none;word-break:keep-all}\n#mmc-root-v1 .mmc-btn .mmc-svg{width:16px;height:16px}\n#mmc-root-v1 .mmc-btn:hover{border-color:var(--mv-accent);color:var(--mv-accent)}\n#mmc-root-v1 .mmc-btn:disabled{opacity:.45;pointer-events:none}\n#mmc-root-v1 .mmc-btn.mmc-sm{min-height:30px;padding:0 11px;border-radius:9px;font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-btn.mmc-sm .mmc-svg{width:14px;height:14px}\n#mmc-root-v1 .mmc-btn.mmc-primary{border-color:var(--mv-accent);background:var(--mv-accent);color:var(--mv-accent-ink)}\n#mmc-root-v1 .mmc-btn.mmc-primary:hover{background:color-mix(in srgb,var(--mv-accent) 88%,#000);color:var(--mv-accent-ink)}\n#mmc-root-v1 .mmc-btn.mmc-model-btn{border-color:color-mix(in srgb,var(--mv-accent-2) 50%,var(--mv-line));background:color-mix(in srgb,var(--mv-accent-2) 10%,var(--mv-paper));color:color-mix(in srgb,var(--mv-accent-2) 80%,var(--mv-ink))}\n#mmc-root-v1 .mmc-btn.mmc-model-btn:hover{border-color:var(--mv-accent-2)}\n#mmc-root-v1 .mmc-btn.mmc-soft{border-color:transparent;background:var(--mv-accent-soft);color:var(--mv-accent)}\n#mmc-root-v1 .mmc-btn.mmc-ghost{border-color:transparent;background:transparent;color:var(--mv-ink-2)}\n#mmc-root-v1 .mmc-btn.mmc-ghost:hover{background:var(--mv-sunk);color:var(--mv-ink)}\n#mmc-root-v1 .mmc-btn.mmc-danger{border-color:color-mix(in srgb,var(--mv-danger) 40%,var(--mv-line));color:var(--mv-danger)}\n#mmc-root-v1 .mmc-btn.mmc-danger:hover{background:color-mix(in srgb,var(--mv-danger) 8%,var(--mv-paper));border-color:var(--mv-danger)}\n#mmc-root-v1 .mmc-btn.mmc-danger-text{color:var(--mv-danger)}\n#mmc-root-v1 .mmc-link{display:inline;padding:0;border:0;background:none;color:var(--mv-accent);font-size:inherit;font-weight:700;text-decoration:underline;text-underline-offset:2px}\n#mmc-root-v1 .mmc-mini{min-height:24px;padding:0 8px;border:1px solid var(--mv-line);border-radius:7px;background:var(--mv-paper);color:var(--mv-muted);font-size:var(--t-2xs);font-weight:700;white-space:nowrap}\n#mmc-root-v1 .mmc-mini:hover{border-color:var(--mv-accent);color:var(--mv-accent)}\n#mmc-root-v1 .mmc-actions{display:flex;flex-wrap:wrap;gap:6px}\n#mmc-root-v1 .mmc-inline-actions{display:flex;gap:6px;flex-wrap:wrap}\n#mmc-root-v1 .mmc-chips{display:flex;flex-wrap:wrap;gap:5px}\n#mmc-root-v1 .mmc-chip{display:inline-flex;align-items:center;min-height:22px;padding:0 8px;border:1px solid var(--mv-line);border-radius:999px;background:var(--mv-paper);color:var(--mv-ink-2);font-size:var(--t-2xs);font-weight:700;white-space:nowrap}\n#mmc-root-v1 .mmc-chip.is-soft{border-color:transparent;background:var(--mv-sunk);color:var(--mv-ink-2)}\n#mmc-root-v1 .mmc-chip.is-ok{border-color:transparent;background:color-mix(in srgb,var(--mv-ok) 13%,var(--mv-paper));color:var(--mv-ok)}\n#mmc-root-v1 .mmc-chip.is-warn{border-color:transparent;background:color-mix(in srgb,var(--mv-warn) 15%,var(--mv-paper));color:color-mix(in srgb,var(--mv-warn) 85%,var(--mv-ink))}\n#mmc-root-v1 .mmc-chip.is-high{border-color:transparent;background:color-mix(in srgb,var(--mv-warn) 16%,var(--mv-paper));color:color-mix(in srgb,var(--mv-warn) 85%,var(--mv-ink))}\n#mmc-root-v1 .mmc-chip.is-done{border-color:transparent;background:color-mix(in srgb,var(--mv-ok) 13%,var(--mv-paper));color:var(--mv-ok)}\n#mmc-root-v1 .mmc-chip.is-hold{border-color:transparent;background:color-mix(in srgb,var(--mv-hold) 16%,var(--mv-paper));color:color-mix(in srgb,var(--mv-hold) 80%,var(--mv-ink))}\n#mmc-root-v1 .mmc-chip.is-cancelled{border-color:transparent;background:var(--mv-sunk);color:var(--mv-muted);text-decoration:line-through}\n#mmc-root-v1 .mmc-seg{display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:11px;background:var(--mv-sunk)}\n#mmc-root-v1 .mmc-seg .mmc-filter,#mmc-root-v1 .mmc-seg>label{display:inline-flex;align-items:center;gap:5px;min-height:30px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--mv-muted);font-size:var(--t-sm);font-weight:700;cursor:pointer;white-space:nowrap}\n#mmc-root-v1 .mmc-seg .mmc-filter i{font:700 var(--t-2xs)/1 var(--mv-mono);font-style:normal;opacity:.8}\n#mmc-root-v1 .mmc-seg .mmc-filter.is-active,#mmc-root-v1 .mmc-seg>label.is-active{background:var(--mv-paper);color:var(--mv-ink);box-shadow:0 1px 3px rgba(0,0,0,.08)}\n#mmc-root-v1 .mmc-seg>label input{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}\n#mmc-root-v1 .mmc-empty{padding:26px 14px;color:var(--mv-muted);font-size:var(--t-sm);line-height:1.6;text-align:center}\n#mmc-root-v1 .mmc-empty-large{max-width:440px;margin:60px auto;border:1px dashed var(--mv-line-2);border-radius:var(--mv-r);background:var(--mv-paper)}\n#mmc-root-v1 .mmc-check{display:grid;place-items:center;flex:none;width:24px;height:24px;padding:0;border:2px solid var(--mv-line-2);border-radius:50%;background:var(--mv-paper);color:#fff;font-size:13px;font-weight:900;line-height:1}\n#mmc-root-v1 .mmc-check:hover{border-color:var(--mv-accent)}\n#mmc-root-v1 .mmc-check.is-checked{border-color:var(--mv-ok);background:var(--mv-ok)}\n#mmc-root-v1 .mmc-check.mmc-pin-check.is-checked{border-color:var(--mv-accent);background:var(--mv-accent);color:var(--mv-accent-ink);font-size:18px}\n#mmc-root-v1 .mmc-evidence-link{display:inline-flex;align-items:center;padding:0;border:0;background:none;color:var(--mv-accent);font-size:var(--t-xs);font-weight:700;text-decoration:underline;text-underline-offset:2px;white-space:nowrap}\n#mmc-root-v1 .mmc-searchbox{display:flex;align-items:center;gap:7px;min-width:0;min-height:36px;padding:0 11px;border:1px solid var(--mv-line);border-radius:10px;background:var(--mv-paper);color:var(--mv-muted)}\n#mmc-root-v1 .mmc-searchbox:focus-within{border-color:var(--mv-accent)}\n#mmc-root-v1 .mmc-searchbox .mmc-svg{width:15px;height:15px}\n#mmc-root-v1 .mmc-searchbox input{flex:1;min-width:0;border:0;background:transparent;color:var(--mv-ink);font-size:var(--t-sm);outline:none}\n#mmc-root-v1 .mmc-m-only{display:none!important}\n#mmc-root-v1 .mmc-summary-alert,#mmc-root-v1 .mmc-agent-note,#mmc-root-v1 .mmc-advanced-memory-note{display:flex;align-items:center;gap:12px;margin:0 0 12px;padding:12px 14px;border:1px solid var(--mv-line);border-radius:var(--mv-r);background:var(--mv-paper)}\n#mmc-root-v1 .mmc-summary-alert>div:nth-child(2),#mmc-root-v1 .mmc-advanced-memory-note>div,#mmc-root-v1 .mmc-agent-note-copy{flex:1;min-width:0}\n#mmc-root-v1 .mmc-summary-alert b,#mmc-root-v1 .mmc-advanced-memory-note b{display:block;font-size:var(--t-md)}\n#mmc-root-v1 .mmc-summary-alert small,#mmc-root-v1 .mmc-advanced-memory-note small{display:block;margin-top:2px;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.5}\n#mmc-root-v1 .mmc-summary-alert>div:last-child{display:flex;gap:6px;flex:none}\n#mmc-root-v1 .mmc-summary-alert{border-color:color-mix(in srgb,var(--mv-accent) 32%,var(--mv-line));border-left:4px solid var(--mv-accent);background:color-mix(in srgb,var(--mv-accent) 5%,var(--mv-paper))}\n#mmc-root-v1 .mmc-undo-alert{border-color:color-mix(in srgb,var(--mv-warn) 38%,var(--mv-line));border-left-color:var(--mv-warn);background:color-mix(in srgb,var(--mv-warn) 6%,var(--mv-paper))}\n#mmc-root-v1 .mmc-alert-icon{display:grid;place-items:center;width:34px;height:34px;flex:none;border-radius:10px;background:var(--mv-accent-soft);color:var(--mv-accent)}\n#mmc-root-v1 .mmc-alert-icon .mmc-svg{width:18px;height:18px}\n#mmc-root-v1 .mmc-agent-note{align-items:flex-start;border-color:color-mix(in srgb,var(--mv-warn) 35%,var(--mv-line));background:color-mix(in srgb,var(--mv-warn) 8%,var(--mv-paper))}\n#mmc-root-v1 .mmc-agent-note .mmc-alert-icon,#mmc-root-v1 .mmc-undo-alert .mmc-alert-icon{background:color-mix(in srgb,var(--mv-warn) 16%,var(--mv-paper));color:color-mix(in srgb,var(--mv-warn) 85%,var(--mv-ink))}\n#mmc-root-v1 .mmc-agent-note-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}\n#mmc-root-v1 .mmc-agent-note-head b{font-size:var(--t-md)}\n#mmc-root-v1 .mmc-agent-note-head span{color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-agent-note p{margin:4px 0 2px;color:var(--mv-ink-2);font-size:var(--t-sm);line-height:1.55}\n#mmc-root-v1 .mmc-agent-note small{display:block;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.5}\n#mmc-root-v1 .mmc-advanced-memory-note .mmc-alert-icon{background:var(--mv-sunk);color:var(--mv-ink-2)}\n#mmc-root-v1 .mmc-setting-warning{display:flex;flex-direction:column;gap:3px;padding:11px 13px;border-radius:10px;background:color-mix(in srgb,var(--mv-warn) 8%,var(--mv-paper));border:1px solid color-mix(in srgb,var(--mv-warn) 26%,var(--mv-line))}\n#mmc-root-v1 .mmc-setting-warning b{font-size:var(--t-sm)}\n#mmc-root-v1 .mmc-setting-warning small{color:var(--mv-ink-2);font-size:var(--t-xs);line-height:1.6}\n#mmc-root-v1 .mmc-ownership-guard{max-width:640px;margin:20px auto;padding:22px 24px;border:1px solid color-mix(in srgb,var(--mv-danger) 30%,var(--mv-line));border-radius:var(--mv-r);background:var(--mv-paper)}\n#mmc-root-v1 .mmc-ownership-guard h2{margin:6px 0 8px;font-size:var(--t-2xl);font-weight:800;letter-spacing:-.02em}\n#mmc-root-v1 .mmc-ownership-guard p{margin:0 0 12px;color:var(--mv-ink-2)}\n#mmc-root-v1 .mmc-ownership-guard dl{display:flex;flex-direction:column;gap:6px;margin:0 0 14px}\n#mmc-root-v1 .mmc-ownership-guard dl>div{display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px;padding:8px 0;border-top:1px solid var(--mv-line)}\n#mmc-root-v1 .mmc-ownership-guard dt{color:var(--mv-muted);font-size:var(--t-xs);font-weight:700}\n#mmc-root-v1 .mmc-ownership-guard dd{margin:0;font-size:var(--t-sm);word-break:break-all}\n#mmc-root-v1 .mmc-ownership-guard code{font-family:var(--mv-mono);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-ownership-actions{display:flex;gap:8px;margin-top:14px}\n#mmc-root-v1 .mmc-overview{display:flex;flex-direction:column;gap:14px}\n#mmc-root-v1 .mmc-overview>[data-mmc-summary-alert-slot]:empty{display:none}\n#mmc-root-v1 .mmc-overview>[data-mmc-summary-alert-slot]>:last-child{margin-bottom:0}\n#mmc-root-v1 .mmc-ov-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:14px;align-items:start}\n#mmc-root-v1 .mmc-inject{padding:18px 20px}\n#mmc-root-v1 .mmc-inject-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}\n#mmc-root-v1 .mmc-inject-head strong{display:flex;align-items:baseline;gap:7px;margin-top:4px;font-size:var(--t-3xl);font-weight:850;letter-spacing:-.03em;line-height:1.1}\n#mmc-root-v1 .mmc-inject-head strong small{color:var(--mv-muted);font-size:var(--t-md);font-weight:700;letter-spacing:0}\n#mmc-root-v1 .mmc-meter{display:flex;gap:3px;height:14px;margin:16px 0 12px;border-radius:999px;overflow:hidden;background:var(--mv-sunk)}\n#mmc-root-v1 .mmc-meter i{display:block;min-width:6px;height:100%}\n#mmc-root-v1 .mmc-meter i.is-promise,#mmc-root-v1 .mmc-legend .is-promise i{background:var(--mv-accent)}\n#mmc-root-v1 .mmc-meter i.is-anchor,#mmc-root-v1 .mmc-legend .is-anchor i{background:var(--mv-accent-2)}\n#mmc-root-v1 .mmc-meter i.is-wiki,#mmc-root-v1 .mmc-legend .is-wiki i{background:var(--mv-ok)}\n#mmc-root-v1 .mmc-meter i.is-empty{flex:1;background:transparent}\n#mmc-root-v1 .mmc-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:0;padding:0;list-style:none;color:var(--mv-ink-2);font-size:var(--t-sm)}\n#mmc-root-v1 .mmc-legend li{display:inline-flex;align-items:center;gap:6px}\n#mmc-root-v1 .mmc-legend li i{width:10px;height:10px;border-radius:3px}\n#mmc-root-v1 .mmc-legend .is-cond i{background:var(--mv-line-2)}\n#mmc-root-v1 .mmc-legend b{font-family:var(--mv-mono);font-weight:800}\n#mmc-root-v1 .mmc-inject-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px;padding-top:12px;border-top:1px dashed var(--mv-line-2)}\n#mmc-root-v1 .mmc-inject-foot small{display:flex;align-items:flex-start;gap:6px;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.5}\n#mmc-root-v1 .mmc-inject-foot small .mmc-svg{width:14px;height:14px;margin-top:2px}\n#mmc-root-v1 .mmc-inbox{padding-bottom:4px}\n#mmc-root-v1 .mmc-inbox-row{display:flex;align-items:center;gap:12px;padding:11px 16px;border-top:1px solid var(--mv-line)}\n#mmc-root-v1 .mmc-inbox-icon{display:grid;place-items:center;width:36px;height:36px;flex:none;border-radius:10px;background:color-mix(in srgb,var(--mv-accent-2) 12%,var(--mv-paper));color:var(--mv-accent-2)}\n#mmc-root-v1 .mmc-inbox-row.is-accent .mmc-inbox-icon{background:var(--mv-accent-soft);color:var(--mv-accent)}\n#mmc-root-v1 .mmc-inbox-row.is-warn .mmc-inbox-icon{background:color-mix(in srgb,var(--mv-warn) 14%,var(--mv-paper));color:color-mix(in srgb,var(--mv-warn) 85%,var(--mv-ink))}\n#mmc-root-v1 .mmc-inbox-row.is-muted .mmc-inbox-icon{background:var(--mv-sunk);color:var(--mv-muted)}\n#mmc-root-v1 .mmc-inbox-copy{flex:1;min-width:0}\n#mmc-root-v1 .mmc-inbox-copy b{display:block;font-size:var(--t-md);font-weight:800;line-height:1.35}\n#mmc-root-v1 .mmc-inbox-copy small{display:block;margin-top:2px;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.45}\n#mmc-root-v1 .mmc-inbox-actions{display:flex;gap:6px;flex:none}\n#mmc-root-v1 .mmc-inbox-empty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:24px 16px 26px;border-top:1px solid var(--mv-line);color:var(--mv-muted);text-align:center}\n#mmc-root-v1 .mmc-inbox-empty .mmc-svg{width:26px;height:26px;margin-bottom:4px}\n#mmc-root-v1 .mmc-inbox-empty b{color:var(--mv-ink-2);font-size:var(--t-md)}\n#mmc-root-v1 .mmc-inbox-empty small{font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}\n#mmc-root-v1 .mmc-stat{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:14px 16px;border:1px solid var(--mv-line);border-radius:var(--mv-r);background:var(--mv-paper);color:var(--mv-ink);text-align:left}\n#mmc-root-v1 .mmc-stat:hover{border-color:var(--mv-accent)}\n#mmc-root-v1 .mmc-stat-top{display:flex;align-items:center;gap:8px;color:var(--mv-ink-2);font-size:var(--t-sm);font-weight:700}\n#mmc-root-v1 .mmc-stat-top i{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--mv-accent-soft);color:var(--mv-accent)}\n#mmc-root-v1 .mmc-stat-top .mmc-svg{width:15px;height:15px}\n#mmc-root-v1 .mmc-stat b{margin-top:6px;font-size:var(--t-3xl);font-weight:850;line-height:1.1;letter-spacing:-.02em}\n#mmc-root-v1 .mmc-stat small{color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-timeline ol{margin:0;padding:0 6px 6px;list-style:none}\n#mmc-root-v1 .mmc-timeline li button{display:flex;align-items:center;gap:12px;width:100%;padding:9px 10px;border:0;border-radius:10px;background:transparent;color:var(--mv-ink);text-align:left}\n#mmc-root-v1 .mmc-timeline li button:hover{background:var(--mv-sunk)}\n#mmc-root-v1 .mmc-timeline li i{display:grid;place-items:center;width:30px;height:30px;flex:none;border-radius:50%;background:var(--mv-accent-soft);color:var(--mv-accent)}\n#mmc-root-v1 .mmc-timeline li i.is-anchor{background:color-mix(in srgb,var(--mv-accent-2) 13%,var(--mv-paper));color:var(--mv-accent-2)}\n#mmc-root-v1 .mmc-timeline li i.is-element{background:var(--mv-sunk);color:var(--mv-ink-2)}\n#mmc-root-v1 .mmc-timeline li i.is-wiki{background:color-mix(in srgb,var(--mv-ok) 13%,var(--mv-paper));color:var(--mv-ok)}\n#mmc-root-v1 .mmc-timeline li i .mmc-svg{width:15px;height:15px}\n#mmc-root-v1 .mmc-timeline li span{flex:1;min-width:0}\n#mmc-root-v1 .mmc-timeline li b{display:block;overflow:hidden;font-size:var(--t-md);font-weight:700;text-overflow:ellipsis;white-space:nowrap}\n#mmc-root-v1 .mmc-timeline li small{color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-timeline li time{flex:none;color:var(--mv-muted);font:600 var(--t-xs)/1 var(--mv-mono)}\n#mmc-root-v1 .mmc-split{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:14px;align-items:start}\n#mmc-root-v1 .mmc-listpane{display:flex;flex-direction:column;overflow:hidden}\n#mmc-root-v1 .mmc-listpane>.mmc-seg{margin:12px 12px 8px;align-self:flex-start}\n#mmc-root-v1 .mmc-tickets{display:flex;flex-direction:column}\n#mmc-root-v1 .mmc-ticket{position:relative;display:flex;align-items:flex-start;gap:12px;padding:14px 16px 14px 18px;border-top:1px solid var(--mv-line)}\n#mmc-root-v1 .mmc-ticket::before{content:\"\";position:absolute;left:0;top:10px;bottom:10px;width:4px;border-radius:0 4px 4px 0;background:var(--mv-line-2)}\n#mmc-root-v1 .mmc-ticket.prio-high::before{background:var(--mv-warn)}\n#mmc-root-v1 .mmc-ticket.prio-normal::before{background:var(--mv-accent)}\n#mmc-root-v1 .mmc-ticket.prio-low::before{background:var(--mv-line-2)}\n#mmc-root-v1 .mmc-ticket.is-selected{background:color-mix(in srgb,var(--mv-accent) 7%,var(--mv-paper))}\n#mmc-root-v1 .mmc-ticket .mmc-check{margin-top:1px}\n#mmc-root-v1 .mmc-ticket-main{flex:1;min-width:0;padding:0;border:0;background:transparent;color:var(--mv-ink);text-align:left}\n#mmc-root-v1 .mmc-ticket-main b{display:block;font-size:var(--t-md);font-weight:800;line-height:1.4}\n#mmc-root-v1 .mmc-ticket-main small{display:block;margin-top:2px;color:var(--mv-ink-2);font-size:var(--t-sm);line-height:1.5}\n#mmc-root-v1 .mmc-ticket-main .mmc-chips{margin-top:8px}\n#mmc-root-v1 .mmc-ticket.is-done .mmc-ticket-main b{color:var(--mv-muted);text-decoration:line-through}\n#mmc-root-v1 .mmc-ticket.is-hold .mmc-ticket-main b,#mmc-root-v1 .mmc-ticket.is-cancelled .mmc-ticket-main b{color:var(--mv-ink-2)}\n#mmc-root-v1 .mmc-ticket-no{flex:none;color:var(--mv-muted);font:600 var(--t-xs)/1.6 var(--mv-mono)}\n#mmc-root-v1 .mmc-listpane-foot{padding:12px 14px;border-top:1px solid var(--mv-line);background:var(--mv-paper-2)}\n#mmc-root-v1 .mmc-detail{position:sticky;top:0;padding:18px 20px}\n#mmc-root-v1 .mmc-detail-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:50px 20px;color:var(--mv-muted);text-align:center}\n#mmc-root-v1 .mmc-detail-empty .mmc-svg{width:30px;height:30px}\n#mmc-root-v1 .mmc-detail-empty b{color:var(--mv-ink-2)}\n#mmc-root-v1 .mmc-detail-head{display:flex;flex-direction:column;align-items:flex-start;gap:8px}\n#mmc-root-v1 .mmc-detail-head h3{margin:0;font-size:var(--t-2xl);font-weight:850;line-height:1.3;letter-spacing:-.02em}\n#mmc-root-v1 .mmc-stepper{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin:16px 0}\n#mmc-root-v1 .mmc-stepper button{min-height:36px;padding:0 6px;border:1px solid var(--mv-line);border-radius:9px;background:var(--mv-paper-2);color:var(--mv-muted);font-size:var(--t-sm);font-weight:800}\n#mmc-root-v1 .mmc-stepper button:hover{border-color:var(--mv-accent);color:var(--mv-ink)}\n#mmc-root-v1 .mmc-stepper button.is-on{border-color:var(--mv-accent);background:var(--mv-accent);color:var(--mv-accent-ink)}\n#mmc-root-v1 .mmc-stepper button.is-on.is-done{border-color:var(--mv-ok);background:var(--mv-ok);color:#fff}\n#mmc-root-v1 .mmc-stepper button.is-on.is-hold{border-color:var(--mv-hold);background:var(--mv-hold);color:#fff}\n#mmc-root-v1 .mmc-stepper button.is-on.is-cancelled{border-color:var(--mv-muted);background:var(--mv-muted);color:var(--mv-paper)}\n#mmc-root-v1 .mmc-detail-sec{margin-top:14px}\n#mmc-root-v1 .mmc-detail-body{margin:0;font-size:var(--t-md);line-height:1.7;white-space:pre-wrap}\n#mmc-root-v1 .mmc-kv{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:14px}\n#mmc-root-v1 .mmc-kv>div{padding:10px 12px;border-radius:10px;background:var(--mv-paper-2);border:1px solid var(--mv-line)}\n#mmc-root-v1 .mmc-kv span{display:block;color:var(--mv-muted);font-size:var(--t-2xs);font-weight:700}\n#mmc-root-v1 .mmc-kv b{display:block;margin-top:2px;font-size:var(--t-sm);font-weight:800;word-break:keep-all}\n#mmc-root-v1 .mmc-quote{margin:0 0 6px;padding:10px 14px;border-left:3px solid var(--mv-accent-2);border-radius:0 10px 10px 0;background:var(--mv-paper-2);color:var(--mv-ink-2);font-size:var(--t-sm);line-height:1.6;white-space:pre-wrap}\n#mmc-root-v1 .mmc-inject-pre{margin:0;padding:12px 14px;border-radius:10px;background:var(--mv-sunk);color:var(--mv-ink-2);font:500 var(--t-xs)/1.65 var(--mv-mono);white-space:pre-wrap;word-break:break-word}\n#mmc-root-v1 .mmc-inject-pre.is-off{color:var(--mv-muted);font-family:var(--mv-font)}\n#mmc-root-v1 .mmc-detail-foot{display:flex;gap:6px;margin-top:18px;padding-top:14px;border-top:1px solid var(--mv-line)}\n#mmc-root-v1 .mmc-budget{margin-bottom:12px;padding:14px 16px}\n#mmc-root-v1 .mmc-budget-head{display:flex;align-items:center;gap:12px}\n#mmc-root-v1 .mmc-budget-head>div{flex:1;min-width:0}\n#mmc-root-v1 .mmc-budget-head b{display:block;font-size:var(--t-md);font-weight:800}\n#mmc-root-v1 .mmc-budget-head small{display:block;color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-budget-head strong{font:800 var(--t-xl)/1 var(--mv-mono);color:var(--mv-accent)}\n#mmc-root-v1 .mmc-budget.is-over .mmc-budget-head strong{color:var(--mv-warn)}\n#mmc-root-v1 .mmc-budget-track{height:10px;margin-top:10px;border-radius:999px;background:var(--mv-sunk);overflow:hidden}\n#mmc-root-v1 .mmc-budget-track i{display:block;height:100%;border-radius:999px;background:var(--mv-accent)}\n#mmc-root-v1 .mmc-budget.is-over .mmc-budget-track i{background:var(--mv-warn)}\n#mmc-root-v1 .mmc-budget-warning{display:block;margin-top:8px;color:color-mix(in srgb,var(--mv-warn) 85%,var(--mv-ink));font-size:var(--t-xs);line-height:1.5}\n#mmc-root-v1 .mmc-toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px}\n#mmc-root-v1 .mmc-lanes{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:start}\n#mmc-root-v1 .mmc-lane{border:1px solid var(--mv-line);border-radius:var(--mv-r);background:var(--mv-paper-2);overflow:hidden}\n#mmc-root-v1 .mmc-lane>header{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--mv-line);background:var(--mv-paper)}\n#mmc-root-v1 .mmc-lane>header>i{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--mv-accent-soft);color:var(--mv-accent)}\n#mmc-root-v1 .mmc-lane.is-keyword>header>i{background:color-mix(in srgb,var(--mv-accent-2) 13%,var(--mv-paper));color:var(--mv-accent-2)}\n#mmc-root-v1 .mmc-lane>header>i .mmc-svg{width:16px;height:16px}\n#mmc-root-v1 .mmc-lane>header>span{flex:1;min-width:0}\n#mmc-root-v1 .mmc-lane>header b{display:block;font-size:var(--t-md);font-weight:800}\n#mmc-root-v1 .mmc-lane>header small{display:block;color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-lane-list{display:flex;flex-direction:column;gap:8px;padding:10px}\n#mmc-root-v1 .mmc-anchor{display:flex;align-items:flex-start;gap:11px;padding:12px 13px;border:1px solid var(--mv-line);border-radius:11px;background:var(--mv-paper)}\n#mmc-root-v1 .mmc-anchor.prio-high{border-left:3px solid var(--mv-warn)}\n#mmc-root-v1 .mmc-anchor.is-muted{opacity:.62}\n#mmc-root-v1 .mmc-anchor.is-budget-wait{border-style:dashed;border-color:color-mix(in srgb,var(--mv-warn) 55%,var(--mv-line))}\n#mmc-root-v1 .mmc-anchor .mmc-check{margin-top:1px}\n#mmc-root-v1 .mmc-anchor-main{flex:1;min-width:0;padding:0;border:0;background:transparent;color:var(--mv-ink);text-align:left}\n#mmc-root-v1 .mmc-anchor-main b{display:block;font-size:var(--t-md);font-weight:800;line-height:1.4}\n#mmc-root-v1 .mmc-anchor-main small{display:block;margin-top:3px;color:var(--mv-ink-2);font-size:var(--t-sm);line-height:1.55}\n#mmc-root-v1 .mmc-anchor-main .mmc-chips{margin-top:8px}\n#mmc-root-v1 .mmc-kw{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}\n#mmc-root-v1 .mmc-kw i{padding:1px 7px;border-radius:6px;background:color-mix(in srgb,var(--mv-accent-2) 12%,var(--mv-paper));color:color-mix(in srgb,var(--mv-accent-2) 85%,var(--mv-ink));font:600 var(--t-2xs)/1.6 var(--mv-mono);font-style:normal}\n#mmc-root-v1 .mmc-kw i::before{content:\"#\"}\n#mmc-root-v1 .mmc-anchor-side{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none}\n#mmc-root-v1 .mmc-element-page{display:flex;flex-direction:column;gap:14px}\n#mmc-root-v1 .mmc-element-toolbox{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px 16px;padding:14px 16px}\n#mmc-root-v1 .mmc-dock-copy{display:flex;align-items:center;gap:12px;min-width:0}\n#mmc-root-v1 .mmc-dock-icon{display:grid;place-items:center;width:38px;height:38px;flex:none;border-radius:11px;background:color-mix(in srgb,var(--mv-accent-2) 13%,var(--mv-paper));color:var(--mv-accent-2)}\n#mmc-root-v1 .mmc-dock-copy b{display:block;font-size:var(--t-md);font-weight:800}\n#mmc-root-v1 .mmc-dock-copy small{display:block;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.5}\n#mmc-root-v1 .mmc-dock-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}\n#mmc-root-v1 .mmc-element-range{display:flex;align-items:center;gap:6px;color:var(--mv-ink-2);font-size:var(--t-sm);font-weight:700}\n#mmc-root-v1 .mmc-element-range label{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}\n#mmc-root-v1 .mmc-element-range input{width:66px;min-height:34px;padding:0 8px;border:1px solid var(--mv-line-2);border-radius:9px;background:var(--mv-paper);color:var(--mv-ink);font:700 var(--t-sm) var(--mv-mono);text-align:center}\n#mmc-root-v1 .mmc-element-status{grid-column:1/-1;display:block;padding-top:10px;line-height:1.6;border-top:1px dashed var(--mv-line-2);color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-el-wrap{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px;align-items:start}\n#mmc-root-v1 .mmc-element-list-head{display:flex;gap:8px;margin-bottom:12px}\n#mmc-root-v1 .mmc-element-list-head .mmc-searchbox{flex:1}\n#mmc-root-v1 .mmc-element-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}\n#mmc-root-v1 .mmc-element-list>.mmc-empty{grid-column:1/-1;border:1px dashed var(--mv-line-2);border-radius:var(--mv-r);background:var(--mv-paper)}\n#mmc-root-v1 .mmc-element-row{position:relative;display:flex;flex-direction:column;border:1px solid var(--mv-line);border-radius:var(--mv-r);background:var(--mv-paper);overflow:hidden}\n#mmc-root-v1 .mmc-element-row::before{content:\"\";position:absolute;top:12px;right:14px;width:9px;height:9px;border-radius:50%;background:var(--mv-bg);box-shadow:inset 0 1px 2px rgba(0,0,0,.18)}\n#mmc-root-v1 .mmc-element-row:hover{border-color:var(--mv-accent)}\n#mmc-root-v1 .mmc-element-main{flex:1;display:flex;flex-direction:column;gap:8px;padding:14px 16px 12px;border:0;background:transparent;color:var(--mv-ink);text-align:left}\n#mmc-root-v1 .mmc-cat-head{display:flex;flex-direction:column;padding-right:18px;padding-bottom:8px;border-bottom:1px solid var(--mv-line)}\n#mmc-root-v1 .mmc-cat-head b{font-size:var(--t-lg);font-weight:850;line-height:1.3}\n#mmc-root-v1 .mmc-cat-head small{color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-facts{display:flex;flex-direction:column;gap:3px;margin:0;padding:0;list-style:none}\n#mmc-root-v1 .mmc-facts li{position:relative;padding-left:12px;color:var(--mv-ink-2);font-size:var(--t-sm);line-height:1.5}\n#mmc-root-v1 .mmc-facts li::before{content:\"\";position:absolute;left:1px;top:.62em;width:5px;height:5px;border-radius:50%;background:var(--mv-accent)}\n#mmc-root-v1 .mmc-facts li.is-more{color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-facts li.is-more::before{display:none}\n#mmc-root-v1 .mmc-element-summary{color:var(--mv-muted);font-size:var(--t-sm)}\n#mmc-root-v1 .mmc-element-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;padding:9px 16px;border-top:1px solid var(--mv-line);background:var(--mv-paper-2);color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-element-meta>span:first-child{margin-right:auto;font-family:var(--mv-mono)}\n#mmc-root-v1 .mmc-el-aside{position:sticky;top:0;display:flex;flex-direction:column;gap:12px}\n#mmc-root-v1 .mmc-element-search-test{display:flex;flex-direction:column;gap:8px;padding:0 14px 14px}\n#mmc-root-v1 .mmc-element-search-test .mmc-card-head{padding:14px 0 0}\n#mmc-root-v1 .mmc-element-search-test>small{font-size:var(--t-xs);line-height:1.5}\n#mmc-root-v1 .mmc-element-search-test textarea{width:100%;min-height:72px;padding:10px 12px;border:1px solid var(--mv-line-2);border-radius:10px;background:var(--mv-paper-2);color:var(--mv-ink);font-size:var(--t-sm);line-height:1.5;resize:vertical;outline:none}\n#mmc-root-v1 .mmc-element-search-test textarea:focus{border-color:var(--mv-accent)}\n#mmc-root-v1 .mmc-element-test-results{display:flex;flex-direction:column;gap:6px}\n#mmc-root-v1 .mmc-element-test-results em{color:var(--mv-muted);font-size:var(--t-xs);font-style:normal}\n#mmc-root-v1 .mmc-hit{display:flex;flex-direction:column;padding:8px 10px;border-radius:9px;background:color-mix(in srgb,var(--mv-ok) 10%,var(--mv-paper));border:1px solid color-mix(in srgb,var(--mv-ok) 25%,var(--mv-line))}\n#mmc-root-v1 .mmc-hit b{font-size:var(--t-sm)}\n#mmc-root-v1 .mmc-hit small{color:var(--mv-ok);font:600 var(--t-2xs)/1.5 var(--mv-mono)}\n#mmc-root-v1 .mmc-rule-note{padding:10px 12px;border-radius:10px;background:var(--mv-sunk)}\n#mmc-root-v1 .mmc-rule-note b{display:block;font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-rule-note small{display:block;color:var(--mv-ink-2);font-size:var(--t-xs);line-height:1.6}\n#mmc-root-v1 .mmc-wiki-document{height:100%}\n#mmc-root-v1 .mmc-wiki-split{display:grid;grid-template-columns:268px minmax(0,1fr);height:100%}\n#mmc-root-v1 .mmc-wiki-side{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--mv-wiki-rule);background:var(--mv-paper-2)}\n#mmc-root-v1 .mmc-wiki-side-tools{display:flex;flex-direction:column;gap:6px;padding:14px 14px 10px}\n#mmc-root-v1 .mmc-wiki-side-tools select{min-height:34px;padding:0 8px;border:1px solid var(--mv-line);border-radius:9px;background:var(--mv-paper);color:var(--mv-ink);font-size:var(--t-sm)}\n#mmc-root-v1 .mmc-wiki-list{flex:1;min-height:0;overflow:auto;padding:0 10px 10px}\n#mmc-root-v1 .mmc-wiki-group{margin-top:8px}\n#mmc-root-v1 .mmc-wiki-group>h4{display:flex;justify-content:space-between;margin:0;padding:6px 6px 4px;color:var(--mv-muted);font-size:var(--t-xs);font-weight:800}\n#mmc-root-v1 .mmc-wiki-group>h4 i{font:700 var(--t-2xs)/1.6 var(--mv-mono);font-style:normal}\n#mmc-root-v1 .mmc-wiki-row{display:flex;flex-direction:column;width:100%;padding:6px 8px 7px;border:0;border-left:3px solid transparent;border-radius:0 8px 8px 0;background:transparent;text-align:left}\n#mmc-root-v1 .mmc-wiki-row:hover{background:var(--mv-sunk)}\n#mmc-root-v1 .mmc-wiki-row.is-active{border-left-color:var(--mv-accent);background:var(--mv-paper)}\n#mmc-root-v1 .mmc-wiki-row-top{display:flex;align-items:center;gap:5px;min-width:0}\n#mmc-root-v1 .mmc-wiki-row-top b{overflow:hidden;color:var(--mv-wiki-link);font-size:var(--t-sm);font-weight:700;text-overflow:ellipsis;white-space:nowrap}\n#mmc-root-v1 .mmc-wiki-row.is-active .mmc-wiki-row-top b{color:var(--mv-ink);font-weight:800}\n#mmc-root-v1 .mmc-wiki-row-sum{overflow:hidden;color:var(--mv-muted);font-size:var(--t-2xs);text-overflow:ellipsis;white-space:nowrap}\n#mmc-root-v1 .mmc-wiki-badge{flex:none;padding:0 6px;border-radius:999px;background:var(--mv-accent-soft);color:var(--mv-accent);font:800 9.5px/16px var(--mv-font);font-style:normal}\n#mmc-root-v1 .mmc-wiki-badge.is-lock{background:var(--mv-sunk);color:var(--mv-ink-2)}\n#mmc-root-v1 .mmc-wiki-badge.is-off{background:var(--mv-sunk);color:var(--mv-muted)}\n#mmc-root-v1 .mmc-wiki-badge.is-pending{background:color-mix(in srgb,var(--mv-accent-2) 15%,var(--mv-paper));color:var(--mv-accent-2)}\n#mmc-root-v1 .mmc-wiki-side-foot{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:12px 14px 14px;border-top:1px solid var(--mv-wiki-rule)}\n#mmc-root-v1 .mmc-wiki-side-foot .mmc-btn{padding:0 8px}\n#mmc-root-v1 .mmc-wiki-status{grid-column:1/-1;display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px;margin-top:4px;color:var(--mv-muted);font-size:var(--t-2xs)}\n#mmc-root-v1 .mmc-wiki-main{min-width:0;min-height:0;overflow:auto;background:var(--mv-paper);scroll-behavior:smooth}\n#mmc-root-v1 .mmc-wiki-actionbar{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:8px;padding:10px 26px;border-bottom:1px solid var(--mv-line);background:color-mix(in srgb,var(--mv-paper) 94%,transparent);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}\n#mmc-root-v1 .mmc-wiki-back{margin-left:-8px}\n#mmc-root-v1 .mmc-wiki-back:not(.has-history){display:none}\n#mmc-root-v1 .mmc-wiki-crumb{display:flex;align-items:center;flex-wrap:wrap;gap:5px;flex:1;min-width:0;color:var(--mv-wiki-link);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-wiki-crumb i{color:var(--mv-muted);font-style:normal}\n#mmc-root-v1 .mmc-wiki-actions{display:inline-flex;align-items:stretch;flex:none;border:1px solid var(--mv-wiki-rule);border-radius:9px;background:var(--mv-paper)}\n#mmc-root-v1 .mmc-wiki-actions>button,#mmc-root-v1 .mmc-wiki-more>summary{display:inline-flex;align-items:center;gap:5px;min-height:30px;padding:0 11px;border:0;border-left:1px solid var(--mv-wiki-rule);background:transparent;color:var(--mv-ink-2);font-size:var(--t-xs);font-weight:700;white-space:nowrap;cursor:pointer}\n#mmc-root-v1 .mmc-wiki-actions>button:first-child{border-left:0;border-radius:8px 0 0 8px}\n#mmc-root-v1 .mmc-wiki-actions>button:hover,#mmc-root-v1 .mmc-wiki-more>summary:hover{background:var(--mv-sunk);color:var(--mv-ink)}\n#mmc-root-v1 .mmc-wiki-actions>button:disabled{opacity:.45}\n#mmc-root-v1 .mmc-wiki-actions .mmc-svg{width:14px;height:14px}\n#mmc-root-v1 .mmc-wiki-actions em{min-width:18px;padding:0 5px;border-radius:999px;background:var(--mv-accent-2);color:#fff;font:800 var(--t-2xs)/17px var(--mv-mono);font-style:normal;text-align:center}\n#mmc-root-v1 .mmc-wiki-more{position:relative}\n#mmc-root-v1 .mmc-wiki-more>summary{list-style:none;border-radius:0 8px 8px 0}\n#mmc-root-v1 .mmc-wiki-more>summary::-webkit-details-marker{display:none}\n#mmc-root-v1 .mmc-wiki-more>div{position:absolute;right:0;top:calc(100% + 6px);z-index:5;display:flex;flex-direction:column;min-width:170px;padding:5px;border:1px solid var(--mv-line-2);border-radius:11px;background:var(--mv-paper);box-shadow:0 12px 30px rgba(0,0,0,.14)}\n#mmc-root-v1 .mmc-wiki-more>div button{padding:8px 10px;border:0;border-radius:7px;background:transparent;color:var(--mv-ink);font-size:var(--t-sm);text-align:left}\n#mmc-root-v1 .mmc-wiki-more>div button:hover{background:var(--mv-sunk)}\n#mmc-root-v1 .mmc-wiki-more>div button.is-danger{color:var(--mv-danger)}\n#mmc-root-v1 .mmc-wiki-article{max-width:960px;padding:20px 30px 40px;color:var(--mv-ink);font-size:var(--t-md);line-height:1.75}\n#mmc-root-v1 .mmc-wiki-article::after{content:\"\";display:block;clear:both}\n#mmc-root-v1 .mmc-wiki-titlebar{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px 12px;padding-bottom:8px;border-bottom:1px solid var(--mv-wiki-rule)}\n#mmc-root-v1 .mmc-wiki-title{margin:0;font-size:calc(34px*var(--fs));font-weight:850;line-height:1.2;letter-spacing:-.03em}\n#mmc-root-v1 .mmc-wiki-title small{margin-left:8px;color:var(--mv-muted);font-size:var(--t-md);font-weight:600;letter-spacing:0}\n#mmc-root-v1 .mmc-wiki-home .mmc-wiki-title{padding-bottom:8px;border-bottom:1px solid var(--mv-wiki-rule)}\n#mmc-root-v1 .mmc-wiki-titlebar small{color:var(--mv-muted);font-size:var(--t-sm)}\n#mmc-root-v1 .mmc-wiki-byline{display:block;margin:8px 0 16px;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.6}\n#mmc-root-v1 .mmc-wiki-byline b{color:var(--mv-ink-2)}\n#mmc-root-v1 .mmc-wiki-byline .mmc-svg{display:inline-block!important;width:12px;height:12px;margin:0 2px -1px 0;vertical-align:-1px}\n#mmc-root-v1 .mmc-wiki-banner{display:flex;align-items:center;gap:12px;margin:0 0 18px;padding:11px 14px;border:1px solid color-mix(in srgb,var(--mv-accent-2) 38%,var(--mv-wiki-rule));border-left:4px solid var(--mv-accent-2);border-radius:9px;background:color-mix(in srgb,var(--mv-accent-2) 7%,var(--mv-paper));line-height:1.45}\n#mmc-root-v1 .mmc-wiki-banner .mmc-alert-icon{background:transparent;width:22px;height:22px;color:var(--mv-accent-2)}\n#mmc-root-v1 .mmc-wiki-banner>div:nth-child(2){flex:1;min-width:0}\n#mmc-root-v1 .mmc-wiki-banner b{display:block;font-size:var(--t-sm)}\n#mmc-root-v1 .mmc-wiki-banner small{display:block;color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-wiki-banner>div:last-child{display:flex;gap:6px;flex:none}\n#mmc-root-v1 .mmc-wiki-infobox{float:right;width:300px;margin:0 0 18px 24px;border:1px solid var(--mv-wiki-rule);background:var(--mv-wiki-box);font-size:var(--t-sm);line-height:1.5}\n#mmc-root-v1 .mmc-wiki-infobox-title{display:block;padding:8px 10px;background:var(--mv-wiki-head);color:var(--mv-wiki-head-ink);font-size:var(--t-lg);font-weight:850;text-align:center}\n#mmc-root-v1 .mmc-wiki-lead-image{margin:0;border-bottom:1px solid var(--mv-wiki-rule);background:var(--mv-paper)}\n#mmc-root-v1 .mmc-wiki-lead-image img{display:block;width:100%;max-height:340px;object-fit:cover}\n#mmc-root-v1 .mmc-wiki-lead-image figcaption{padding:5px 8px;color:var(--mv-muted);font-size:var(--t-2xs);text-align:center}\n#mmc-root-v1 .mmc-wiki-infobox table{width:100%;border-collapse:collapse}\n#mmc-root-v1 .mmc-wiki-infobox th,#mmc-root-v1 .mmc-wiki-infobox td{padding:7px 10px;border-top:1px solid var(--mv-wiki-rule);vertical-align:top;text-align:left}\n#mmc-root-v1 .mmc-wiki-infobox th{width:34%;background:color-mix(in srgb,var(--mv-wiki-head) 9%,var(--mv-wiki-box));color:var(--mv-ink);font-weight:800;white-space:nowrap}\n#mmc-root-v1 .mmc-wiki-infobox td{background:var(--mv-paper);word-break:keep-all;overflow-wrap:anywhere}\n#mmc-root-v1 .mmc-wiki-state td{padding:5px 8px}\n#mmc-root-v1 .mmc-wiki-toggle{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:3px 4px 3px 8px;border:1px solid var(--mv-line);border-radius:999px;background:var(--mv-paper-2);color:var(--mv-muted);font-size:var(--t-xs);font-weight:700}\n#mmc-root-v1 .mmc-wiki-toggle i{position:relative;width:30px;height:18px;flex:none;border-radius:999px;background:var(--mv-line-2);transition:background .15s}\n#mmc-root-v1 .mmc-wiki-toggle i::after{content:\"\";position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:left .15s}\n#mmc-root-v1 .mmc-wiki-toggle.is-on{border-color:color-mix(in srgb,var(--mv-accent) 40%,var(--mv-line));color:var(--mv-accent)}\n#mmc-root-v1 .mmc-wiki-toggle.is-on i{background:var(--mv-accent)}\n#mmc-root-v1 .mmc-wiki-toggle.is-on i::after{left:14px}\n#mmc-root-v1 .mmc-wiki-lead{margin-bottom:6px}\n#mmc-root-v1 .mmc-wiki-summary-lock{display:flex;align-items:center;gap:5px;color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-wiki-summary-lock .mmc-svg{width:13px;height:13px}\n#mmc-root-v1 .mmc-wiki-toc{display:inline-block;min-width:220px;max-width:100%;margin:10px 0 8px;padding:12px 18px 12px 14px;border:1px solid var(--mv-wiki-rule);background:var(--mv-wiki-box)}\n#mmc-root-v1 .mmc-wiki-toc>b{display:block;margin-bottom:4px;font-size:var(--t-md);font-weight:850}\n#mmc-root-v1 .mmc-wiki-toc ol{margin:0;padding:0;list-style:none}\n#mmc-root-v1 .mmc-wiki-toc li[data-wiki-level=\"2\"]{padding-left:18px}\n#mmc-root-v1 .mmc-wiki-toc li[data-wiki-level=\"3\"]{padding-left:36px}\n#mmc-root-v1 .mmc-wiki-toc button{display:flex;gap:6px;padding:2px 0;border:0;background:transparent;color:var(--mv-wiki-link);font-size:var(--t-sm);text-align:left}\n#mmc-root-v1 .mmc-wiki-toc button:hover{text-decoration:underline}\n#mmc-root-v1 .mmc-wiki-toc button i{color:var(--mv-wiki-link);font-style:normal;font-weight:700}\n#mmc-root-v1 .mmc-wiki-section{margin-top:18px}\n#mmc-root-v1 .mmc-wh{display:flex;align-items:center;gap:8px;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid var(--mv-wiki-rule);color:var(--mv-ink);font-weight:850;line-height:1.35;letter-spacing:-.01em}\n#mmc-root-v1 .mmc-wiki-section[data-wiki-level=\"1\"]>.mmc-wh{font-size:var(--t-2xl)}\n#mmc-root-v1 .mmc-wiki-section[data-wiki-level=\"2\"]>.mmc-wh{font-size:var(--t-xl);border-bottom-style:dashed}\n#mmc-root-v1 .mmc-wiki-section[data-wiki-level=\"3\"]>.mmc-wh{font-size:var(--t-lg);border-bottom:0}\n#mmc-root-v1 .mmc-wh-text{flex:1;min-width:0}\n#mmc-root-v1 .mmc-wiki-h-num{margin-right:7px;color:var(--mv-accent);font-style:normal}\n#mmc-root-v1 .mmc-wiki-manage{display:inline-flex;align-items:center;gap:3px;padding:1px 8px;border-radius:999px;background:var(--mv-accent-soft);color:var(--mv-accent);font-size:var(--t-2xs);font-style:normal;font-weight:800;white-space:nowrap}\n#mmc-root-v1 .mmc-wiki-manage .mmc-svg{width:11px;height:11px}\n#mmc-root-v1 .mmc-wh-edit{flex:none;padding:0;border:0;background:transparent;color:var(--mv-wiki-link);font-size:var(--t-xs);font-weight:600}\n#mmc-root-v1 .mmc-wh-edit:hover{text-decoration:underline}\n#mmc-root-v1 .mmc-wiki-body p{margin:0 0 10px}\n#mmc-root-v1 .mmc-wiki-body ul,#mmc-root-v1 .mmc-wiki-body ol{margin:0 0 10px;padding-left:24px}\n#mmc-root-v1 .mmc-wiki-body ul{list-style:disc}\n#mmc-root-v1 .mmc-wiki-body ol{list-style:decimal}\n#mmc-root-v1 .mmc-wiki-body li{margin:2px 0}\n#mmc-root-v1 .mmc-wiki-body blockquote{margin:0 0 10px;padding:8px 14px;border-left:4px solid var(--mv-wiki-rule);background:var(--mv-wiki-box);color:var(--mv-ink-2)}\n#mmc-root-v1 .mmc-wiki-body pre{margin:0 0 10px;padding:10px 12px;border:1px solid var(--mv-wiki-rule);background:var(--mv-wiki-box);font:500 var(--t-xs)/1.6 var(--mv-mono);white-space:pre-wrap}\n#mmc-root-v1 .mmc-wiki-body code{padding:1px 5px;border-radius:5px;background:var(--mv-sunk);font:500 .9em var(--mv-mono)}\n#mmc-root-v1 .mmc-wiki-body hr{border:0;border-top:1px solid var(--mv-wiki-rule);margin:14px 0}\n#mmc-root-v1 .mmc-wiki-body h4,#mmc-root-v1 .mmc-wiki-body h5,#mmc-root-v1 .mmc-wiki-body h6{margin:12px 0 6px;font-size:var(--t-md);font-weight:800}\n#mmc-root-v1 .mmc-wiki-body strong{font-weight:800}\n#mmc-root-v1 .mmc-wiki-link{display:inline;padding:0;border:0;background:transparent;color:var(--mv-wiki-link);font:inherit;text-align:left;text-decoration:none;cursor:pointer}\n#mmc-root-v1 .mmc-wiki-link:hover{text-decoration:underline}\n#mmc-root-v1 .mmc-wiki-link.is-missing{color:var(--mv-wiki-missing)}\n#mmc-root-v1 .mmc-wiki-cite{display:inline;margin:0 1px;padding:0;border:0;background:transparent;color:var(--mv-wiki-link);font-size:.72em;font-weight:800;vertical-align:super;line-height:0;cursor:pointer}\n#mmc-root-v1 .mmc-wiki-cite::before{content:\"[\"}\n#mmc-root-v1 .mmc-wiki-cite::after{content:\"]\"}\n#mmc-root-v1 .mmc-wiki-cite.is-missing{color:var(--mv-muted)}\n#mmc-root-v1 .mmc-wiki-original{margin:4px 0 10px;padding:6px 10px;border:1px dashed var(--mv-wiki-rule);border-radius:8px;font-size:var(--t-sm)}\n#mmc-root-v1 .mmc-wiki-original summary{color:var(--mv-muted);font-size:var(--t-xs);cursor:pointer}\n#mmc-root-v1 .mmc-wiki-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}\n#mmc-root-v1 .mmc-wiki-figure{margin:0;border:1px solid var(--mv-wiki-rule);background:var(--mv-wiki-box)}\n#mmc-root-v1 .mmc-wiki-figure img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}\n#mmc-root-v1 .mmc-wiki-figure figcaption{padding:4px 8px;color:var(--mv-muted);font-size:var(--t-2xs)}\n#mmc-root-v1 .mmc-wiki-seealso{display:grid;grid-template-columns:1fr 1fr;gap:12px}\n#mmc-root-v1 .mmc-wiki-seealso>div{padding:10px 12px;border:1px solid var(--mv-wiki-rule);background:var(--mv-wiki-box)}\n#mmc-root-v1 .mmc-wiki-seealso span{display:block;margin-bottom:4px;color:var(--mv-muted);font-size:var(--t-xs);font-weight:700}\n#mmc-root-v1 .mmc-wiki-linkrow{display:flex;flex-wrap:wrap;gap:4px 12px}\n#mmc-root-v1 .mmc-wiki-linkrow .mmc-wiki-link::before{content:\"→ \";color:var(--mv-muted)}\n#mmc-root-v1 .mmc-wiki-sources{margin:0;padding:0;list-style:none;font-size:var(--t-sm)}\n#mmc-root-v1 .mmc-wiki-sources li{padding:4px 0}\n#mmc-root-v1 .mmc-wiki-sources li>.mmc-wiki-cite{margin-right:6px;font-size:var(--t-xs);vertical-align:baseline;line-height:inherit}\n#mmc-root-v1 .mmc-wiki-sources details{margin:4px 0 0 28px}\n#mmc-root-v1 .mmc-wiki-sources summary{color:var(--mv-muted);font-size:var(--t-xs);cursor:pointer}\n#mmc-root-v1 .mmc-wiki-sources pre{margin:4px 0 0;padding:8px 10px;background:var(--mv-wiki-box);border:1px solid var(--mv-wiki-rule);font:500 var(--t-xs)/1.55 var(--mv-mono);white-space:pre-wrap}\n#mmc-root-v1 .mmc-wiki-doc-foot{clear:both;margin-top:26px;padding-top:10px;border-top:1px solid var(--mv-wiki-rule);color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-wiki-muted{color:var(--mv-muted)}\n#mmc-root-v1 .mmc-wiki-recent{margin:0;padding:0;list-style:none;columns:2;column-gap:24px}\n#mmc-root-v1 .mmc-wiki-recent li{display:flex;flex-direction:column;padding:4px 0;break-inside:avoid}\n#mmc-root-v1 .mmc-wiki-recent small{color:var(--mv-muted);font-size:var(--t-2xs)}\n#mmc-root-v1 .mmc-wiki-cats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}\n#mmc-root-v1 .mmc-wiki-cat{display:flex;justify-content:space-between;align-items:center;padding:9px 12px;border:1px solid var(--mv-wiki-rule);background:var(--mv-wiki-box);color:var(--mv-wiki-link);font-size:var(--t-sm);text-align:left}\n#mmc-root-v1 .mmc-wiki-cat small{color:var(--mv-muted);font:700 var(--t-2xs) var(--mv-mono)}\n#mmc-root-v1 .mmc-wiki-cat.is-empty{color:var(--mv-muted)}\n#mmc-root-v1 .mmc-wiki-cat:hover{border-color:var(--mv-accent)}\n#mmc-root-v1 .mmc-wiki-home-actions{display:flex;gap:8px;margin-top:22px}\n#mmc-root-v1 .mmc-layer-backdrop{position:absolute;inset:0;z-index:12;display:flex;justify-content:flex-end;background:color-mix(in srgb,var(--mv-ink) 26%,transparent)}\n#mmc-root-v1 .mmc-layer{display:flex;flex-direction:column;width:min(560px,100%);height:100%;border-left:1px solid var(--mv-line-2);background:var(--mv-bg);box-shadow:-20px 0 50px rgba(0,0,0,.14);animation:mmc-sheet-in .18s ease-out}\n@keyframes mmc-sheet-in{from{transform:translateX(24px);opacity:.4}to{transform:none;opacity:1}}\n#mmc-root-v1 .mmc-layer.mmc-source-layer,#mmc-root-v1 .mmc-layer.mmc-wiki-editor,#mmc-root-v1 .mmc-layer.mmc-wiki-draft-layer,#mmc-root-v1 .mmc-layer.mmc-wiki-candidates-layer,#mmc-root-v1 .mmc-layer.mmc-wiki-proposal-layer,#mmc-root-v1 .mmc-layer.mmc-element-candidates-layer,#mmc-root-v1 .mmc-layer.mmc-help-layer,#mmc-root-v1 .mmc-layer.mmc-element-editor{width:min(760px,100%)}\n#mmc-root-v1 .mmc-layer>header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 18px 14px;border-bottom:1px solid var(--mv-line);background:var(--mv-paper)}\n#mmc-root-v1 .mmc-layer>header>div{min-width:0}\n#mmc-root-v1 .mmc-layer>header h3{margin:2px 0 0;font-size:var(--t-xl);font-weight:850;line-height:1.3;letter-spacing:-.02em}\n#mmc-root-v1 .mmc-layer>header small{display:block;margin-top:3px;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.5}\n#mmc-root-v1 .mmc-sheet-title{display:flex;align-items:center;gap:10px}\n#mmc-root-v1 .mmc-sheet-title h3{margin:0!important}\n#mmc-root-v1 .mmc-sheet-icon{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:var(--mv-accent);color:var(--mv-accent-ink)}\n#mmc-root-v1 .mmc-sheet-icon .mmc-svg{width:18px;height:18px}\n#mmc-root-v1 .mmc-sheet-nav,#mmc-root-v1 .mmc-help-tabs{display:flex;gap:2px;padding:0 14px;border-bottom:1px solid var(--mv-line);background:var(--mv-paper);overflow-x:auto;scrollbar-width:none}\n#mmc-root-v1 .mmc-sheet-nav button,#mmc-root-v1 .mmc-help-tabs button{position:relative;min-height:42px;padding:0 12px;border:0;background:transparent;color:var(--mv-muted);font-size:var(--t-sm);font-weight:800;white-space:nowrap}\n#mmc-root-v1 .mmc-sheet-nav button.is-active,#mmc-root-v1 .mmc-help-tabs button.is-active{color:var(--mv-ink)}\n#mmc-root-v1 .mmc-sheet-nav button.is-active::after,#mmc-root-v1 .mmc-help-tabs button.is-active::after{content:\"\";position:absolute;left:10px;right:10px;bottom:-1px;height:3px;border-radius:3px 3px 0 0;background:var(--mv-accent)}\n#mmc-root-v1 .mmc-layer-body{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px;padding:16px 18px 20px;overscroll-behavior:contain}\n#mmc-root-v1 .mmc-sheet-pane{display:flex;flex-direction:column;gap:12px}\n#mmc-root-v1 .mmc-layer-body>*,#mmc-root-v1 .mmc-sheet-pane>*{flex-shrink:0}\n#mmc-root-v1 .mmc-layer>footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 18px;border-top:1px solid var(--mv-line);background:var(--mv-paper)}\n#mmc-root-v1 .mmc-layer>footer>div{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}\n#mmc-root-v1 .mmc-field{display:flex;flex-direction:column;gap:5px;min-width:0;color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-field>span{color:var(--mv-ink-2);font-weight:800}\n#mmc-root-v1 .mmc-field small{font-weight:500;color:var(--mv-muted)}\n#mmc-root-v1 .mmc-field input,#mmc-root-v1 .mmc-field select,#mmc-root-v1 .mmc-field textarea,#mmc-root-v1 .mmc-setting input,#mmc-root-v1 .mmc-setting select,#mmc-root-v1 .mmc-model-strip select,#mmc-root-v1 .mmc-wiki-edit-section input,#mmc-root-v1 .mmc-wiki-edit-section select,#mmc-root-v1 .mmc-wiki-edit-section textarea,#mmc-root-v1 .mmc-setting-block textarea,#mmc-root-v1 .mmc-raw-repair textarea{width:100%;min-height:38px;padding:8px 11px;border:1px solid var(--mv-line-2);border-radius:10px;background:var(--mv-paper);color:var(--mv-ink);font-size:var(--t-sm);line-height:1.55;outline:none}\n#mmc-root-v1 .mmc-field textarea,#mmc-root-v1 .mmc-setting-block textarea,#mmc-root-v1 .mmc-wiki-edit-section textarea{resize:vertical}\n#mmc-root-v1 .mmc-field input:focus,#mmc-root-v1 .mmc-field select:focus,#mmc-root-v1 .mmc-field textarea:focus,#mmc-root-v1 .mmc-setting input:focus,#mmc-root-v1 .mmc-setting select:focus,#mmc-root-v1 .mmc-setting-block textarea:focus,#mmc-root-v1 .mmc-wiki-edit-section input:focus,#mmc-root-v1 .mmc-wiki-edit-section textarea:focus{border-color:var(--mv-accent);box-shadow:0 0 0 3px var(--mv-accent-soft)}\n#mmc-root-v1 .mmc-field-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}\n#mmc-root-v1 .mmc-check-line{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--mv-line);border-radius:10px;background:var(--mv-paper);color:var(--mv-ink);font-size:var(--t-sm);cursor:pointer}\n#mmc-root-v1 .mmc-check-line input{width:18px;height:18px;margin:2px 0 0;accent-color:var(--mv-accent);flex:none}\n#mmc-root-v1 .mmc-check-line span b{display:block;font-weight:800}\n#mmc-root-v1 .mmc-check-line span small{display:block;color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-source-quote{padding:8px 12px;border:1px dashed var(--mv-line-2);border-radius:10px;background:var(--mv-paper);font-size:var(--t-sm)}\n#mmc-root-v1 .mmc-source-quote summary{color:var(--mv-muted);font-size:var(--t-xs);font-weight:700;cursor:pointer}\n#mmc-root-v1 .mmc-source-quote p{margin:8px 0 0;color:var(--mv-ink-2);white-space:pre-wrap}\n#mmc-root-v1 .mmc-trigger-box{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper-2)}\n#mmc-root-v1 .mmc-trigger-box>div:first-child b{display:block;font-size:var(--t-md)}\n#mmc-root-v1 .mmc-trigger-box>div:first-child small{display:block;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.5}\n#mmc-root-v1 .mmc-element-editor-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}\n#mmc-root-v1 .mmc-wiki-summary-row{grid-template-columns:minmax(0,1fr) 180px}\n#mmc-root-v1 .mmc-wiki-count{align-self:flex-end;color:var(--mv-muted);font:600 var(--t-2xs) var(--mv-mono)}\n#mmc-root-v1 .mmc-wiki-count.is-over{color:var(--mv-danger)}\n#mmc-root-v1 .mmc-wiki-edit-sections-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:6px}\n#mmc-root-v1 .mmc-wiki-edit-sections-head b{font-size:var(--t-md)}\n#mmc-root-v1 .mmc-wiki-edit-sections-head small{margin-left:4px;color:var(--mv-muted);font-size:var(--t-xs);font-weight:500}\n#mmc-root-v1 .mmc-wiki-edit-section{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper)}\n#mmc-root-v1 .mmc-wiki-edit-section[data-wiki-level=\"2\"]{margin-left:18px}\n#mmc-root-v1 .mmc-wiki-edit-section[data-wiki-level=\"3\"]{margin-left:36px}\n#mmc-root-v1 .mmc-wiki-edit-section-head{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:6px}\n#mmc-root-v1 .mmc-wiki-edit-section-head select{width:auto}\n#mmc-root-v1 .mmc-wiki-edit-image-head{display:flex;justify-content:space-between;align-items:center}\n#mmc-root-v1 .mmc-source-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:6px}\n#mmc-root-v1 .mmc-source-toolbar span{margin-left:auto;color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-source-list{display:flex;flex-direction:column;gap:8px}\n#mmc-root-v1 .mmc-source-row{display:flex;gap:10px;padding:10px 12px;border:1px solid var(--mv-line);border-radius:11px;background:var(--mv-paper);cursor:pointer}\n#mmc-root-v1 .mmc-source-row.is-selected{border-color:var(--mv-accent);background:color-mix(in srgb,var(--mv-accent) 5%,var(--mv-paper))}\n#mmc-root-v1 .mmc-source-row input{width:17px;height:17px;margin-top:2px;accent-color:var(--mv-accent);flex:none}\n#mmc-root-v1 .mmc-source-copy{min-width:0;flex:1}\n#mmc-root-v1 .mmc-source-copy b{display:block;font-size:var(--t-sm)}\n#mmc-root-v1 .mmc-source-copy small{display:block;color:var(--mv-muted);font-size:var(--t-2xs)}\n#mmc-root-v1 .mmc-source-copy p{margin:4px 0 0;color:var(--mv-ink-2);font-size:var(--t-xs);line-height:1.55;white-space:pre-wrap;word-break:break-word}\n#mmc-root-v1 .mmc-model-strip{display:grid;grid-template-columns:minmax(0,1fr) 240px;align-items:center;gap:12px;padding:12px;border:1px solid color-mix(in srgb,var(--mv-accent-2) 30%,var(--mv-line));border-radius:12px;background:color-mix(in srgb,var(--mv-accent-2) 6%,var(--mv-paper))}\n#mmc-root-v1 .mmc-model-strip b{display:block;font-size:var(--t-sm)}\n#mmc-root-v1 .mmc-model-strip small{display:block;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.5}\n#mmc-root-v1 .mmc-wiki-source-group{display:flex;flex-direction:column;gap:8px}\n#mmc-root-v1 .mmc-wiki-source-group-head{display:flex;align-items:center;justify-content:space-between}\n#mmc-root-v1 .mmc-wiki-source-group-head small{color:var(--mv-muted);font-family:var(--mv-mono)}\n#mmc-root-v1 .mmc-candidate-note{padding:10px 12px;border-radius:10px;background:var(--mv-sunk);color:var(--mv-ink-2);font-size:var(--t-xs);line-height:1.6}\n#mmc-root-v1 .mmc-warning-note{background:color-mix(in srgb,var(--mv-warn) 10%,var(--mv-paper));color:color-mix(in srgb,var(--mv-warn) 70%,var(--mv-ink))}\n#mmc-root-v1 .mmc-candidate-toolbar{position:sticky;top:-16px;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border:1px solid var(--mv-line);border-radius:10px;background:var(--mv-paper)}\n#mmc-root-v1 .mmc-candidate-toolbar b{font-size:var(--t-sm)}\n#mmc-root-v1 .mmc-candidate-toolbar small{color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-candidate-toolbar>div{display:flex;gap:6px}\n#mmc-root-v1 .mmc-candidate-group{display:flex;flex-direction:column;gap:8px}\n#mmc-root-v1 .mmc-candidate-group-head{display:flex;align-items:center;gap:10px}\n#mmc-root-v1 .mmc-candidate-group-head b{display:block;font-size:var(--t-md)}\n#mmc-root-v1 .mmc-candidate-group-head small{display:block;color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-type-chip{display:inline-flex;align-items:center;justify-content:center;min-width:42px;min-height:22px;padding:0 8px;border-radius:999px;background:var(--mv-accent-soft);color:var(--mv-accent);font-size:var(--t-2xs);font-weight:800;white-space:nowrap}\n#mmc-root-v1 .mmc-candidate-group.is-anchor .mmc-type-chip{background:color-mix(in srgb,var(--mv-accent-2) 14%,var(--mv-paper));color:var(--mv-accent-2)}\n#mmc-root-v1 .mmc-candidate-list{display:flex;flex-direction:column;gap:8px}\n#mmc-root-v1 .mmc-candidate{display:flex;gap:10px;padding:11px 12px;border:1px solid var(--mv-line);border-radius:11px;background:var(--mv-paper);cursor:pointer}\n#mmc-root-v1 .mmc-candidate.is-selected{border-color:var(--mv-accent);background:color-mix(in srgb,var(--mv-accent) 5%,var(--mv-paper))}\n#mmc-root-v1 .mmc-candidate.is-conflict{border-color:color-mix(in srgb,var(--mv-danger) 40%,var(--mv-line));opacity:.8}\n#mmc-root-v1 .mmc-candidate input{width:17px;height:17px;margin-top:2px;accent-color:var(--mv-accent);flex:none}\n#mmc-root-v1 .mmc-candidate>span{flex:1;min-width:0}\n#mmc-root-v1 .mmc-candidate b{display:block;font-size:var(--t-sm)}\n#mmc-root-v1 .mmc-candidate small{display:block;color:var(--mv-muted);font-size:var(--t-2xs)}\n#mmc-root-v1 .mmc-candidate p{margin:4px 0 0;color:var(--mv-ink-2);font-size:var(--t-xs);line-height:1.55;white-space:pre-wrap}\n#mmc-root-v1 .mmc-candidate em{display:block;margin-top:4px;color:var(--mv-accent-2);font-size:var(--t-2xs);font-style:normal}\n#mmc-root-v1 .mmc-review-before{display:block!important;margin-top:4px;padding:5px 8px;border-left:2px solid var(--mv-line-2);background:var(--mv-paper-2);line-height:1.45}\n#mmc-root-v1 .mmc-conflict-note{color:var(--mv-danger)!important}\n#mmc-root-v1 .mmc-review-candidate [data-review-action=\"add\"]{color:var(--mv-ok)}\n#mmc-root-v1 .mmc-review-candidate [data-review-action=\"update\"]{color:var(--mv-accent)}\n#mmc-root-v1 .mmc-review-candidate [data-review-action=\"complete\"]{color:var(--mv-ok)}\n#mmc-root-v1 .mmc-review-candidate [data-review-action=\"archive\"]{color:var(--mv-warn)}\n#mmc-root-v1 .mmc-review-candidate [data-review-action=\"keep\"]{color:var(--mv-muted)}\n#mmc-root-v1 .mmc-element-candidate,#mmc-root-v1 .mmc-wiki-candidate,#mmc-root-v1 .mmc-wiki-change{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper)}\n#mmc-root-v1 .mmc-wiki-candidate.is-selected,#mmc-root-v1 .mmc-wiki-change.is-selected{border-color:var(--mv-accent)}\n#mmc-root-v1 .mmc-element-candidate-head,#mmc-root-v1 .mmc-wiki-candidate-head,#mmc-root-v1 .mmc-wiki-change-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px}\n#mmc-root-v1 .mmc-element-candidate-head label,#mmc-root-v1 .mmc-wiki-candidate-head label{display:inline-flex;align-items:center;gap:6px}\n#mmc-root-v1 .mmc-element-candidate-head input,#mmc-root-v1 .mmc-wiki-candidate-head input,#mmc-root-v1 .mmc-wiki-change-head input{width:17px;height:17px;accent-color:var(--mv-accent)}\n#mmc-root-v1 .mmc-element-candidate-head b,#mmc-root-v1 .mmc-wiki-candidate-head b,#mmc-root-v1 .mmc-wiki-change-head b{font-size:var(--t-md)}\n#mmc-root-v1 .mmc-element-candidate-head small,#mmc-root-v1 .mmc-wiki-candidate-head small{margin-left:auto;color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-wiki-diff{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}\n#mmc-root-v1 .mmc-wiki-diff-side{padding:8px 10px;border-radius:9px;font-size:var(--t-xs);line-height:1.55}\n#mmc-root-v1 .mmc-wiki-diff-side b{display:block;margin-bottom:3px;font-size:var(--t-2xs)}\n#mmc-root-v1 .mmc-wiki-diff-side p{margin:0 0 3px;white-space:pre-wrap}\n#mmc-root-v1 .mmc-wiki-diff-side.is-before{background:color-mix(in srgb,var(--mv-danger) 8%,var(--mv-paper));color:color-mix(in srgb,var(--mv-danger) 60%,var(--mv-ink))}\n#mmc-root-v1 .mmc-wiki-diff-side.is-before p{text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--mv-danger) 50%,transparent)}\n#mmc-root-v1 .mmc-wiki-diff-side.is-after{background:color-mix(in srgb,var(--mv-ok) 9%,var(--mv-paper));color:color-mix(in srgb,var(--mv-ok) 60%,var(--mv-ink))}\n#mmc-root-v1 .mmc-evidence-group{display:flex;flex-direction:column;gap:8px}\n#mmc-root-v1 .mmc-evidence-group h4{margin:0;font-size:var(--t-sm);font-weight:800}\n#mmc-root-v1 .mmc-evidence-fact{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--mv-line);border-radius:11px;background:var(--mv-paper)}\n#mmc-root-v1 .mmc-evidence-fact.is-focus{border-color:var(--mv-accent);box-shadow:0 0 0 3px var(--mv-accent-soft)}\n#mmc-root-v1 .mmc-evidence-fact-head{display:grid;grid-template-columns:auto auto minmax(0,1fr);align-items:baseline;gap:8px}\n#mmc-root-v1 .mmc-evidence-fact-head span{color:var(--mv-accent);font:800 var(--t-xs) var(--mv-mono)}\n#mmc-root-v1 .mmc-evidence-fact-head small{color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-evidence-layer pre,#mmc-root-v1 .mmc-evidence-fact pre{margin:0;padding:8px 10px;border-radius:8px;background:var(--mv-sunk);color:var(--mv-ink-2);font:500 var(--t-xs)/1.6 var(--mv-mono);white-space:pre-wrap;word-break:break-word}\n#mmc-root-v1 .mmc-evidence-ids{display:flex;flex-wrap:wrap;gap:4px}\n#mmc-root-v1 .mmc-evidence-ids code{padding:1px 6px;border-radius:5px;background:var(--mv-sunk);font:500 var(--t-2xs) var(--mv-mono)}\n#mmc-root-v1 .mmc-preview-block{border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper);overflow:hidden}\n#mmc-root-v1 .mmc-preview-block>header{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:10px 12px;border-bottom:1px solid var(--mv-line)}\n#mmc-root-v1 .mmc-preview-block>header small{color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-preview-block pre{margin:0;padding:10px 12px;background:var(--mv-paper-2);color:var(--mv-ink-2);font:500 var(--t-xs)/1.65 var(--mv-mono);white-space:pre-wrap;word-break:break-word}\n#mmc-root-v1 .mmc-preview-block.is-promise>header{border-left:4px solid var(--mv-accent)}\n#mmc-root-v1 .mmc-preview-block.is-anchor>header{border-left:4px solid var(--mv-accent-2)}\n#mmc-root-v1 .mmc-preview-block.is-wiki>header{border-left:4px solid var(--mv-ok)}\n#mmc-root-v1 .mmc-guide{display:flex;flex-direction:column;gap:8px}\n#mmc-root-v1 .mmc-guide section{padding:11px 14px;border:1px solid var(--mv-line);border-left:3px solid var(--mv-accent);border-radius:0 10px 10px 0;background:var(--mv-paper)}\n#mmc-root-v1 .mmc-guide b{font-size:var(--t-md)}\n#mmc-root-v1 .mmc-guide p{margin:4px 0 0;color:var(--mv-ink-2);font-size:var(--t-sm);line-height:1.65}\n#mmc-root-v1 .mmc-guide code{padding:0 4px;border-radius:4px;background:var(--mv-sunk);font:500 .92em var(--mv-mono)}\n#mmc-root-v1 .mmc-raw-repair textarea{flex:1;min-height:40dvh;font:500 var(--t-xs)/1.55 var(--mv-mono)}\n#mmc-root-v1 .mmc-set-card{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper)}\n#mmc-root-v1 .mmc-set-head b{display:block;font-size:var(--t-lg);font-weight:850}\n#mmc-root-v1 .mmc-set-head small{display:block;margin-top:2px;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.6}\n#mmc-root-v1 .mmc-set-head strong{color:var(--mv-ink);font-weight:800}\n#mmc-root-v1 .mmc-setting{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--mv-line)}\n#mmc-root-v1 .mmc-set-card>.mmc-set-head+.mmc-setting{border-top:1px solid var(--mv-line)}\n#mmc-root-v1 .mmc-setting>span b{display:block;font-size:var(--t-sm);font-weight:800}\n#mmc-root-v1 .mmc-setting>span small{display:block;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.55}\n#mmc-root-v1 .mmc-setting input,#mmc-root-v1 .mmc-setting select{width:auto;min-width:120px;max-width:260px}\n#mmc-root-v1 .mmc-setting input[type=\"number\"]{width:110px;min-width:0;font-family:var(--mv-mono);text-align:right}\n#mmc-root-v1 .mmc-setting-model{grid-template-columns:minmax(0,1fr) minmax(180px,260px)}\n#mmc-root-v1 .mmc-setting-model select{width:100%;max-width:none}\n#mmc-root-v1 .mmc-set-card>.mmc-setting:first-child{border-top:0;padding-top:0}\n#mmc-root-v1 .mmc-setting-block{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper)}\n#mmc-root-v1 .mmc-setting-block>span,#mmc-root-v1 .mmc-setting-block-head>span{display:flex;flex-direction:column}\n#mmc-root-v1 .mmc-setting-block b{font-size:var(--t-sm);font-weight:800}\n#mmc-root-v1 .mmc-setting-block small{color:var(--mv-muted);font-size:var(--t-xs);line-height:1.55}\n#mmc-root-v1 .mmc-setting-block-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}\n#mmc-root-v1 .mmc-setting-block textarea{font:500 var(--t-xs)/1.6 var(--mv-mono)}\n#mmc-root-v1 .mmc-setting-card{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px;border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper)}\n#mmc-root-v1 .mmc-setting-card>div:first-child{min-width:0}\n#mmc-root-v1 .mmc-setting-card b{display:block;font-size:var(--t-sm);font-weight:800}\n#mmc-root-v1 .mmc-setting-card small{display:block;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.55;word-break:break-all}\n#mmc-root-v1 .mmc-setting-card em{display:block;margin-top:3px;color:var(--mv-danger);font-size:var(--t-xs);font-style:normal}\n#mmc-root-v1 .mmc-theme-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}\n#mmc-root-v1 .mmc-theme-card{position:relative;display:block;cursor:pointer}\n#mmc-root-v1 .mmc-theme-card input{position:absolute;opacity:0;pointer-events:none}\n#mmc-root-v1 .mmc-theme-card-ui{position:relative;display:flex;flex-direction:column;gap:2px;height:100%;padding:10px 10px 12px;border:1.5px solid var(--mv-line);border-radius:12px;background:var(--mv-paper)}\n#mmc-root-v1 .mmc-theme-card:hover .mmc-theme-card-ui{border-color:var(--mv-line-2)}\n#mmc-root-v1 .mmc-theme-card input:checked+.mmc-theme-card-ui{border-color:var(--mv-accent);box-shadow:0 0 0 3px var(--mv-accent-soft)}\n#mmc-root-v1 .mmc-theme-card input:focus-visible+.mmc-theme-card-ui{outline:2px solid var(--mv-accent);outline-offset:2px}\n#mmc-root-v1 .mmc-theme-card-ui strong{margin-top:8px;font-size:var(--t-md);font-weight:850}\n#mmc-root-v1 .mmc-theme-card-ui small{color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-theme-check{position:absolute;bottom:12px;right:12px;display:none;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--mv-accent);color:var(--mv-accent-ink);font-size:12px;font-style:normal;font-weight:900}\n#mmc-root-v1 .mmc-theme-card input:checked+.mmc-theme-card-ui .mmc-theme-check{display:grid}\n#mmc-root-v1 .mmc-tp{display:grid;grid-template-columns:1fr 1fr;gap:5px;height:84px;padding:6px;border-radius:9px;background:var(--tp-desk)}\n#mmc-root-v1 .mmc-tp-app,#mmc-root-v1 .mmc-tp-wiki{position:relative;display:flex;flex-direction:column;gap:5px;padding:12px 6px 6px;border-radius:5px;background:var(--tp-bg);overflow:hidden}\n#mmc-root-v1 .mmc-tp-wiki{background:var(--tp-paper)}\n#mmc-root-v1 .mmc-tp i{position:absolute;left:0;right:0;top:0;height:4px;background:var(--tp-accent)}\n#mmc-root-v1 .mmc-tp-app b{display:block;height:9px;border-radius:3px;background:var(--tp-paper)}\n#mmc-root-v1 .mmc-tp-wiki b{display:block;height:2px;width:70%;background:var(--tp-link)}\n#mmc-root-v1 .mmc-tp-wiki b:nth-of-type(2){width:55%}\n#mmc-root-v1 .mmc-tp-wiki b:nth-of-type(3){width:62%}\n#mmc-root-v1 .mmc-tp-wiki s{position:absolute;right:5px;top:10px;width:26%;height:60%;border:1px solid var(--tp-rule);background:var(--tp-box);text-decoration:none}\n#mmc-root-v1 .mmc-tp-wiki s::before{content:\"\";position:absolute;left:0;right:0;top:0;height:5px;background:var(--tp-head)}\n#mmc-root-v1 [data-tp=\"ribbon\"]{--tp-desk:#dcdbe6;--tp-bg:#f4f3f9;--tp-paper:#fff;--tp-accent:#5b5fb5;--tp-link:#4450c4;--tp-head:#5b5fb5;--tp-box:#f6f5fb;--tp-rule:#d6d4e6}\n#mmc-root-v1 [data-tp=\"rose\"]{--tp-desk:#e2d6d5;--tp-bg:#f7f1f0;--tp-paper:#fffdfc;--tp-accent:#a14c64;--tp-link:#a53f5c;--tp-head:#7d3c4e;--tp-box:#faf3f3;--tp-rule:#e2d1d3}\n#mmc-root-v1 [data-tp=\"green\"]{--tp-desk:#d3dcda;--tp-bg:#f2f5f4;--tp-paper:#fff;--tp-accent:#00a495;--tp-link:#0f7fbd;--tp-head:#00a495;--tp-box:#f5f7f7;--tp-rule:#ccd6d3}\n#mmc-root-v1 [data-tp=\"marinara\"]{--tp-desk:#0c0e11;--tp-bg:#15171c;--tp-paper:#1b1e24;--tp-accent:var(--primary,#8fb3ff);--tp-link:var(--primary,#9fc0ff);--tp-head:#3a4a6e;--tp-box:#1f232a;--tp-rule:#343a45}\n#mmc-root-v1 .mmc-theme-note{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;background:var(--mv-accent-soft);color:var(--mv-ink-2);font-size:var(--t-xs);line-height:1.6}\n#mmc-root-v1 .mmc-theme-note .mmc-svg{width:15px;height:15px;margin-top:2px;color:var(--mv-accent)}\n#mmc-root-v1 .mmc-wiki-theme-link{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--mv-line);border-radius:11px;background:var(--mv-paper-2)}\n#mmc-root-v1 .mmc-wiki-theme-link>span:nth-child(2){flex:1;min-width:0}\n#mmc-root-v1 .mmc-wiki-theme-link b{display:block;font-size:var(--t-md);font-weight:850}\n#mmc-root-v1 .mmc-wiki-theme-link small{display:block;color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-swatch{width:46px;height:34px;flex:none;border-radius:8px;background:linear-gradient(90deg,var(--tp-bg) 0 34%,var(--tp-accent) 34% 67%,var(--tp-link) 67% 100%);box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}\n#mmc-root-v1 .mmc-busy{position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:color-mix(in srgb,var(--mv-bg) 86%,transparent);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}\n#mmc-root-v1 .mmc-spinner{width:30px;height:30px;border:3px solid var(--mv-line-2);border-top-color:var(--mv-accent);border-radius:50%;animation:mmc-spin .9s linear infinite}\n@keyframes mmc-spin{to{transform:rotate(360deg)}}\n#mmc-root-v1 .mmc-busy b{font-size:var(--t-md)}\n#mmc-root-v1 .mmc-busy small{color:var(--mv-muted);font:600 var(--t-xs) var(--mv-mono)}\n@media(max-width:1020px){#mmc-root-v1 .mmc-brand-text small{display:none}\n#mmc-root-v1 .mmc-sync span{display:none}\n#mmc-root-v1 .mmc-sync{padding:0 9px}\n#mmc-root-v1 .mmc-el-wrap{grid-template-columns:minmax(0,1fr)}\n#mmc-root-v1 .mmc-el-aside{position:static}\n#mmc-root-v1 .mmc-stats{grid-template-columns:repeat(2,minmax(0,1fr))}\n#mmc-root-v1 .mmc-wiki-infobox{width:250px}\n#mmc-root-v1 .mmc-wiki-cats{grid-template-columns:repeat(2,minmax(0,1fr))}}\n@media(max-width:860px){#mmc-root-v1 .mmc-ov-grid,#mmc-root-v1 .mmc-lanes{grid-template-columns:minmax(0,1fr)}\n#mmc-root-v1 .mmc-split{grid-template-columns:minmax(0,1fr)}\n#mmc-root-v1 .mmc-detail{position:static}\n#mmc-root-v1 .mmc-wiki-split{grid-template-columns:220px minmax(0,1fr)}\n#mmc-root-v1 .mmc-wiki-infobox{float:none;width:auto;margin:0 0 16px}}\n@media(max-width:700px){#mmc-root-v1 .mmc-overlay{padding:0;align-items:stretch}\n#mmc-root-v1 .mmc-shell{width:100vw;height:100dvh;border:0;border-radius:0;grid-template-rows:auto minmax(0,1fr) auto}\n#mmc-root-v1 .mmc-bar{flex-wrap:wrap;gap:8px;padding:max(12px,env(safe-area-inset-top)) 12px 10px}\n#mmc-root-v1 .mmc-brand-text{display:none}\n#mmc-root-v1 .mmc-brand-mark{width:36px;height:36px}\n#mmc-root-v1 .mmc-story{order:5;flex:1 1 100%;max-width:none;margin:0}\n#mmc-root-v1 .mmc-icon-btn{width:36px;height:36px}\n#mmc-root-v1 .mmc-tabs{grid-row:3;justify-content:space-around;gap:0;padding:4px 4px max(6px,env(safe-area-inset-bottom));border-top:1px solid var(--mv-line-2);border-bottom:0;overflow:visible}\n#mmc-root-v1 .mmc-tab{flex:1;flex-direction:column;gap:2px;min-height:54px;margin:0;padding:6px 2px 4px;border:0;border-radius:12px;font-size:var(--t-2xs)}\n#mmc-root-v1 .mmc-tab .mmc-svg{width:21px;height:21px}\n#mmc-root-v1 .mmc-tab-long{display:none}\n#mmc-root-v1 .mmc-tab-short{display:inline}\n#mmc-root-v1 .mmc-tab em{position:absolute;top:1px;left:calc(50% + 6px);min-width:18px;height:18px;padding:0 5px;font-size:10px;line-height:18px;box-shadow:0 0 0 2px var(--mv-paper)}\n#mmc-root-v1 .mmc-tab-dot{position:absolute;top:6px;left:calc(50% + 10px)}\n#mmc-root-v1 .mmc-tab.is-active{background:var(--mv-accent-soft);color:var(--mv-accent)}\n#mmc-root-v1 .mmc-tab.is-active::before{display:none}\n#mmc-root-v1 .mmc-body{padding:14px 12px 20px}\n#mmc-root-v1 .mmc-m-only{display:inline-flex!important}\n#mmc-root-v1 .mmc-summary-alert,#mmc-root-v1 .mmc-agent-note,#mmc-root-v1 .mmc-advanced-memory-note,#mmc-root-v1 .mmc-wiki-banner{flex-wrap:wrap}\n#mmc-root-v1 .mmc-summary-alert>div:nth-child(2),#mmc-root-v1 .mmc-wiki-banner>div:nth-child(2){flex:1 1 calc(100% - 50px)}\n#mmc-root-v1 .mmc-summary-alert>div:last-child,#mmc-root-v1 .mmc-wiki-banner>div:last-child{flex:1 1 100%}\n#mmc-root-v1 .mmc-summary-alert>div:last-child .mmc-btn,#mmc-root-v1 .mmc-wiki-banner>div:last-child .mmc-btn{flex:1}\n#mmc-root-v1 .mmc-inject{padding:16px}\n#mmc-root-v1 .mmc-inject-foot{flex-direction:column;align-items:stretch}\n#mmc-root-v1 .mmc-inbox-row{flex-wrap:wrap}\n#mmc-root-v1 .mmc-inbox-copy{flex:1 1 calc(100% - 52px)}\n#mmc-root-v1 .mmc-inbox-actions{margin-left:48px}\n#mmc-root-v1 .mmc-kv{grid-template-columns:repeat(2,minmax(0,1fr))}\n#mmc-root-v1 .mmc-kv>div:last-child{grid-column:1/-1}\n#mmc-root-v1 .mmc-split[data-pane=\"list\"]>.mmc-detail{display:none}\n#mmc-root-v1 .mmc-split[data-pane=\"detail\"]>.mmc-listpane{display:none}\n#mmc-root-v1 .mmc-listpane-foot .mmc-actions .mmc-btn{flex:1}\n#mmc-root-v1 .mmc-toolbar{flex-direction:column;align-items:stretch}\n#mmc-root-v1 .mmc-toolbar .mmc-actions .mmc-btn{flex:1}\n#mmc-root-v1 .mmc-element-toolbox{grid-template-columns:minmax(0,1fr)}\n#mmc-root-v1 .mmc-dock-controls{justify-content:flex-start}\n#mmc-root-v1 .mmc-dock-controls>.mmc-btn{flex:1 1 100%}\n#mmc-root-v1 .mmc-element-list{grid-template-columns:minmax(0,1fr)}\n#mmc-root-v1 .mmc-shell[data-tab=\"wiki\"] .mmc-body{padding:0}\n#mmc-root-v1 .mmc-wiki-split{grid-template-columns:minmax(0,1fr)}\n#mmc-root-v1 .mmc-wiki-split[data-wiki-pane=\"doc\"]>.mmc-wiki-side{display:none}\n#mmc-root-v1 .mmc-wiki-split[data-wiki-pane=\"list\"]>.mmc-wiki-main{display:none}\n#mmc-root-v1 .mmc-wiki-side{border-right:0}\n#mmc-root-v1 .mmc-wiki-actionbar{padding:8px 12px;flex-wrap:nowrap}\n#mmc-root-v1 .mmc-wiki-back,#mmc-root-v1 .mmc-wiki-back:not(.has-history){display:inline-flex}\n#mmc-root-v1 .mmc-wiki-crumb{display:none}\n#mmc-root-v1 .mmc-wiki-actions{margin-left:auto}\n#mmc-root-v1 .mmc-wiki-article{padding:14px 16px 30px}\n#mmc-root-v1 .mmc-wiki-title{font-size:calc(28px*var(--fs))}\n#mmc-root-v1 .mmc-wiki-infobox{float:none;width:auto;margin:0 0 16px}\n#mmc-root-v1 .mmc-wiki-lead-image img{max-height:260px}\n#mmc-root-v1 .mmc-wiki-toc{display:block}\n#mmc-root-v1 .mmc-wiki-seealso{grid-template-columns:minmax(0,1fr)}\n#mmc-root-v1 .mmc-wiki-recent{columns:1}\n#mmc-root-v1 .mmc-wiki-home-actions{flex-direction:column}\n#mmc-root-v1 .mmc-layer{width:100%!important;border-left:0;animation:none}\n#mmc-root-v1 .mmc-layer>header{padding-top:max(14px,env(safe-area-inset-top))}\n#mmc-root-v1 .mmc-layer>footer{padding-bottom:max(12px,env(safe-area-inset-bottom));flex-wrap:wrap}\n#mmc-root-v1 .mmc-layer>footer>div{flex:1;justify-content:stretch}\n#mmc-root-v1 .mmc-layer>footer>div .mmc-btn{flex:1}\n#mmc-root-v1 .mmc-field-row,#mmc-root-v1 .mmc-element-editor-grid,#mmc-root-v1 .mmc-wiki-summary-row,#mmc-root-v1 .mmc-model-strip{grid-template-columns:minmax(0,1fr)}\n#mmc-root-v1 .mmc-setting,#mmc-root-v1 .mmc-setting-model{grid-template-columns:minmax(0,1fr)}\n#mmc-root-v1 .mmc-setting input,#mmc-root-v1 .mmc-setting select{max-width:none;width:100%}\n#mmc-root-v1 .mmc-setting input[type=\"number\"]{width:100%;text-align:left}\n#mmc-root-v1 .mmc-setting-card{flex-direction:column;align-items:stretch}\n#mmc-root-v1 .mmc-setting-block-head{flex-direction:column}\n#mmc-root-v1 .mmc-candidate-toolbar{flex-direction:column;align-items:flex-start}\n#mmc-root-v1 .mmc-wiki-edit-section-head{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}\n#mmc-root-v1 .mmc-wiki-edit-section-head input{grid-column:1/-1}\n#mmc-root-v1 .mmc-ownership-guard dl>div{grid-template-columns:minmax(0,1fr)}\n#mmc-root-v1 .mmc-ownership-actions{flex-direction:column}}\n@media(max-width:380px){#mmc-root-v1 .mmc-theme-cards{grid-template-columns:minmax(0,1fr)}\n#mmc-root-v1 .mmc-stats{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}}\n/* v2.1 · 아는 인물 범위 */\n#mmc-root-v1 .mmc-meter i.is-restricted,#mmc-root-v1 .mmc-legend .is-restricted i{background:var(--mv-accent-2)}\n#mmc-root-v1 .mmc-preview-block.is-restricted>header{border-left:4px solid var(--mv-accent-2)}\n#mmc-root-v1 .mmc-advanced-memory-note.is-warn .mmc-alert-icon{background:color-mix(in srgb,var(--mv-warn) 15%,var(--mv-paper));color:var(--mv-warn)}\n#mmc-root-v1 .mmc-advanced-memory-note small+small{margin-top:4px}\n#mmc-root-v1 .mmc-scope{display:flex;flex-direction:column;gap:5px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--mv-line)}\n#mmc-root-v1 .mmc-scope-label{display:flex;align-items:center;gap:5px;color:var(--mv-ink-2);font-size:var(--t-2xs);font-weight:600}\n#mmc-root-v1 .mmc-scope-label .mmc-svg{width:13px;height:13px}\n#mmc-root-v1 .mmc-scope.is-restricted .mmc-scope-label{color:var(--mv-accent-2)}\n#mmc-root-v1 .mmc-scope.is-pending .mmc-scope-label{color:var(--mv-warn)}\n#mmc-root-v1 .mmc-scope-chips{display:flex;flex-wrap:wrap;gap:5px;align-items:center}\n#mmc-root-v1 .mmc-scope-chip{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:2px 9px;border:1px solid var(--mv-line-2);border-radius:6px;background:var(--mv-paper);color:var(--mv-ink-2);font-size:var(--t-2xs);cursor:pointer}\n#mmc-root-v1 .mmc-scope-chip input{width:13px;height:13px;margin:0;accent-color:var(--mv-accent-2)}\n#mmc-root-v1 .mmc-scope-chip.is-on{border-color:var(--mv-accent-2);background:color-mix(in srgb,var(--mv-accent-2) 10%,var(--mv-paper));color:var(--mv-ink)}\n#mmc-root-v1 .mmc-scope-warn{color:var(--mv-warn)!important;font-size:var(--t-2xs);line-height:1.5}\n#mmc-root-v1 .mmc-hold-row{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:default}\n#mmc-root-v1 .mmc-hold-row>span:first-child{min-width:0;flex:1}\n#mmc-root-v1 .mmc-hold-actions{display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}\n#mmc-root-v1 .mmc-hold-group-actions{margin-left:auto}\n@media (max-width:520px){#mmc-root-v1 .mmc-hold-row{flex-direction:column;align-items:stretch}#mmc-root-v1 .mmc-hold-actions{justify-content:flex-start}}\n/* v2.1 · 장면 기억 */\n#mmc-root-v1 .mmc-episode-note{display:flex;flex-direction:column;gap:2px;min-width:0}\n#mmc-root-v1 .mmc-episode-note small{color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-episode-list{display:grid;gap:12px}\n#mmc-root-v1 .mmc-episode{padding:14px 16px}\n#mmc-root-v1 .mmc-episode.is-replaced{opacity:.72}\n#mmc-root-v1 .mmc-episode-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:8px}\n#mmc-root-v1 .mmc-episode-head>div{flex:1;min-width:0}\n#mmc-root-v1 .mmc-episode-head b{display:block;font-size:var(--t-md)}\n#mmc-root-v1 .mmc-episode-head small{display:block;margin-top:2px;color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-episode-grid{display:grid;gap:8px;margin:0}\n#mmc-root-v1 .mmc-episode-grid>div{display:grid;grid-template-columns:52px minmax(0,1fr);gap:10px}\n#mmc-root-v1 .mmc-episode-grid dt{color:var(--mv-muted);font-size:var(--t-2xs);font-weight:700;padding-top:2px}\n#mmc-root-v1 .mmc-episode-grid dd{margin:0;color:var(--mv-ink-2);font-size:var(--t-xs);line-height:1.55;min-width:0}\n#mmc-root-v1 .mmc-episode-grid dd small{display:block;color:var(--mv-muted);margin-top:2px}\n#mmc-root-v1 .mmc-episode-grid ul,#mmc-root-v1 .mmc-episode-cand ul{margin:4px 0 0;padding-left:16px}\n#mmc-root-v1 .mmc-episode-facts{list-style:none;padding-left:0!important;display:grid;gap:4px}\n#mmc-root-v1 .mmc-episode-facts li{display:flex;flex-wrap:wrap;align-items:center;gap:5px}\n#mmc-root-v1 .mmc-episode-facts li>span:not(.mmc-chip){flex:1 1 180px;min-width:0}\n#mmc-root-v1 .mmc-episode-facts .mmc-scope{flex:1 1 100%;margin-top:2px;padding-top:4px}\n#mmc-root-v1 .mmc-episode-people{list-style:none;padding-left:0!important;display:grid;gap:4px}\n#mmc-root-v1 .mmc-episode-old{margin-top:14px}\n#mmc-root-v1 .mmc-episode-old summary{cursor:pointer;color:var(--mv-muted);font-size:var(--t-xs);margin-bottom:8px}\n#mmc-root-v1 .mmc-episode-cand{display:flex;gap:10px;align-items:flex-start;cursor:default}\n#mmc-root-v1 .mmc-episode-cand>span{flex:1;min-width:0}\n#mmc-root-v1 .mmc-scope-note{display:block;color:var(--mv-ink-2);font-size:var(--t-2xs);margin-top:4px}\n#mmc-root-v1 .mmc-episode-fact-edit{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}\n#mmc-root-v1 .mmc-episode-fact-edit select{flex:0 0 auto;min-height:36px}\n#mmc-root-v1 .mmc-episode-fact-edit input{flex:1 1 200px;min-width:0;min-height:36px}\n#mmc-root-v1 .mmc-episode-fact-edit .mmc-scope{flex:1 1 100%}\n/* v2.1 · 진행 흐름 */\n#mmc-root-v1 .mmc-meter i.is-thread,#mmc-root-v1 .mmc-legend .is-thread i{background:var(--mv-warn)}\n#mmc-root-v1 .mmc-preview-block.is-thread>header{border-left:4px solid var(--mv-warn)}\n#mmc-root-v1 .mmc-thread{padding:14px 16px}\n#mmc-root-v1 .mmc-thread.is-resolved,#mmc-root-v1 .mmc-thread.is-cancelled{opacity:.75}\n#mmc-root-v1 .mmc-thread-state{margin:2px 0 6px;color:var(--mv-ink);font-size:var(--t-sm);line-height:1.55;white-space:pre-wrap}\n#mmc-root-v1 .mmc-thread-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}\n#mmc-root-v1 .mmc-thread-history{margin-top:10px}\n#mmc-root-v1 .mmc-thread-history summary{cursor:pointer;color:var(--mv-muted);font-size:var(--t-xs)}\n#mmc-root-v1 .mmc-thread-history ol{list-style:none;margin:8px 0 0;padding:0 0 0 10px;border-left:2px solid var(--mv-line);display:grid;gap:6px}\n#mmc-root-v1 .mmc-thread-history li{display:flex;flex-wrap:wrap;align-items:center;gap:5px;font-size:var(--t-xs);color:var(--mv-ink-2)}\n#mmc-root-v1 .mmc-thread-history li>span:not(.mmc-chip){flex:1 1 200px;min-width:0}\n#mmc-root-v1 .mmc-thread-history li small{flex:1 1 100%;color:var(--mv-muted);font-size:var(--t-2xs)}\n#mmc-root-v1 .mmc-scope-note .mmc-svg{width:12px;height:12px;vertical-align:-2px;margin-right:3px}\n/* v2.1.1 · 후보 전체 선택·전체 보류 */\n#mmc-root-v1 .mmc-bulk-toolbar{flex-wrap:wrap;row-gap:8px}\n#mmc-root-v1 .mmc-bulk-count{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 180px}\n#mmc-root-v1 .mmc-bulk-actions{display:flex;gap:6px;flex:0 0 auto}\n#mmc-root-v1 .mmc-bulk-actions .mmc-btn{white-space:nowrap}\n@media(max-width:700px){#mmc-root-v1 .mmc-bulk-toolbar{flex-direction:column;align-items:stretch}\n#mmc-root-v1 .mmc-bulk-count{flex:0 0 auto}\n#mmc-root-v1 .mmc-bulk-actions{width:100%}\n#mmc-root-v1 .mmc-bulk-actions .mmc-btn{flex:1 1 0;min-height:36px}}\n";

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
#mmc-root-v1 .lv-bulk{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0}
#mmc-root-v1 .lv-bulk .mmc-btn,#mmc-root-v1 .lv-actions .mmc-btn,#mmc-root-v1 .lv-diag .mmc-btn{min-height:44px}
#mmc-root-v1 .lv-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
#mmc-root-v1 .lv-hint{padding:10px 12px;border-left:3px solid var(--mv-accent);background:var(--mv-paper-2);border-radius:6px;font-size:12px}
#mmc-root-v1 .lv-diag{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
#mmc-root-v1 .lv-diag>li{padding:8px 10px;border:1px solid var(--mv-line);border-radius:8px;font-size:12px}
#mmc-root-v1 .lv-diag>li[data-tone=warn]{border-left:3px solid var(--mv-warn)}
#mmc-root-v1 .lv-diag details{border:0;padding:0;margin-top:4px}
#mmc-root-v1 .lv-diag .lv-title{min-height:44px;font-weight:600;font-size:13px}
#mmc-root-v1 .lv-proposal .lv-line{gap:4px}
#mmc-root-v1 .lv-proposal pre{padding:8px;border-radius:6px;background:var(--mv-paper-2);font-size:12px}
#mmc-root-v1 .lv-proposal.is-conflict{opacity:.7;border-color:var(--mv-warn)}
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
export function createView(root,{send,get,ui,confirm=async()=>true}){
 const el=(tag,text,parent,cls)=>{const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;(parent||root).appendChild(x);return x;};
 const button=(text,fn,parent,cls='')=>{const b=el('button',text,parent,'mmc-btn '+cls);b.type='button';b.onclick=fn;return b;};
 const card=(parent,title)=>{const c=el('section',undefined,parent,'mmc-card lv-card');if(title)el('h3',title,c);return c;};
 const row=parent=>el('div',undefined,parent,'lv-row');
 const field=(label,tag,parent,value='')=>{const l=el('label',label,parent,'lv-field'),x=el(tag,undefined,l);x.setAttribute('aria-label',label);if(tag!=='select')x.value=value;return x;};
 const check=(label,parent,checked=false)=>{const l=el('label',undefined,parent,'lv-check'),x=el('input',undefined,l);x.type='checkbox';x.checked=checked;x.setAttribute('aria-label',label);el('span',label,l);return x;};
 const select=(label,options,parent,value)=>{const x=field(label,'select',parent);for(const [id,name] of options){const o=el('option',name,x);o.value=id;if(id===value)o.setAttribute('selected','');}return x;};
 // Entering the analysis view re-asks the message count (numbers only, no bodies) so a
 // chat that grew since the last visit is not blocked by a stale total.
 const go=(tab,open)=>{if(tab==='analysis')ui.countAsked=null;ui.tab=tab;ui.editor=null;ui.filter='all';ui.detail=open?'list:'+open:null;ui.limits={};ui.queries={};ui.selected.clear();render();};
 const title=x=>clip(x.title||x.text.split('\n')[0])||'제목 없는 기억';
 const matches=(x,q)=>!q||(title(x)+' '+x.text).toLowerCase().includes(q.toLowerCase());
 const explain=x=>[hasLifecycle(x.layer)?(x.status==='completed'?'완료':x.status==='cancelled'?'취소':'진행 중'):['completed','cancelled'].includes(x.status)?'주입 제외 (이전 상태)':'',x.scope==='public'?'공개':x.scope==='secret'?'비밀':x.scope==='character'?'인물 제한':'비공개 (주입 안 함)',x.hold?'보류':'',x.branchHold?'분기 보류':'',x.importedScope?'가져온 범위 보류':'',x.review?'근거 재검토':'',x.locked?'잠금':''].filter(Boolean).join(' · ');
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
 function searchable(parent,key,label,rows,draw,empty,onChange){
  const search=field(label,'input',parent,ui.queries[key]||'');search.type='search';
  const host=el('div',undefined,parent);
  const refresh=()=>{host.replaceChildren();const q=ui.queries[key]||'',hits=rows.filter(x=>matches(x,q));
   if(!hits.length){el('div',q?'검색 결과가 없어요.':empty,host,'mmc-empty mmc-card');return;}
   if(q)el('small','검색 결과 '+hits.length+'개',host,'mmc-muted');
   paged(host,hits,key,draw,x=>ui.detail===key+':'+x.id);
  };
  search.oninput=()=>{ui.queries[key]=search.value;ui.limits[key]=PAGE;refresh();onChange?.();};
  refresh();
 }
 function disclosure(parent){return check('공개 범위 확대 확인',parent);}
 // Selection count shown in every bulk bar; row checkboxes update it in place.
 const countText=()=>'선택 '+ui.selected.size+'개';
 const recount=()=>{for(const n of root.querySelectorAll('[data-selected-count]'))n.textContent=countText();};
 const visibleIn=(rows,key)=>rows.filter(x=>matches(x,ui.queries[key]||''));
 // Delete always asks with the count; undo stays available in the settings tab.
 async function confirmDelete(ids,what){
  if(!ids.length){ui.note('삭제할 항목을 먼저 고르세요.');return;}
  const ok=await confirm({title:'선택 삭제',message:what+' '+ids.length+'개를 삭제합니다. 설정 탭의 되돌리기로 되살릴 수 있습니다.',variant:'danger',confirmLabel:ids.length+'개 삭제',cancelLabel:'취소'});
  if(ok){ui.selected.clear();send('delete',{ids});}else ui.note('삭제를 취소했습니다.');
 }
 // Review queue: approval is the user's scope decision. 승인 = 모두가 아는 기억 (injected);
 // 비공개로 보관 = saved but never injected. Candidates that need a one-by-one look
 // (existing-item changes, holds, re-review, secret/character limits, …) never join a bulk approval.
 function queueBulk(parent,state,rows){
  const bar=el('div',undefined,parent,'lv-bulk');bar.dataset.bulk='queue';
  button('전체 선택 (위험 후보 제외)',()=>{
   const v=visibleIn(rows(),'queue'),safe=selectSafeCandidates(v),skipped=v.length-safe.length;
   ui.selected=new Set(safe);render();
   ui.note(safe.length+'개 선택'+(skipped?' · 직접 확인이 필요한 후보 '+skipped+'개(기존 항목 변경·보류·재검토·비밀 등)는 빼고 골랐습니다. 하나씩 열어 확인하세요.':''));
  },bar).dataset.selectAll='queue';
  button('선택 해제',()=>{ui.selected.clear();render();},bar);
  const picked=()=>state.candidates.filter(x=>ui.selected.has(x.id));
  const approve=scope=>{
   const p=picked(),ok=p.filter(x=>!candidateRisks(x).length),left=p.length-ok.length;
   if(!ok.length){ui.note(left?'고른 후보가 모두 직접 확인이 필요한 후보입니다. 하나씩 열어 승인하세요.':'승인할 후보를 먼저 고르세요.');return;}
   send('approve',{ids:ok.map(x=>x.id),scope,...(scope==='public'?{confirmPublic:true}:{})});
   ui.selected.clear();
   if(left)ui.note('직접 확인이 필요한 후보 '+left+'개는 빼고 '+ok.length+'개를 보냈습니다.');
  };
  button('선택 승인',()=>approve('public'),bar,'mmc-primary').dataset.approve='public';
  button('선택 비공개로 보관',()=>approve('unknown'),bar).dataset.approve='unknown';
  button('선택 보류',()=>{const ids=picked().map(x=>x.id);if(!ids.length){ui.note('보류할 후보를 먼저 고르세요.');return;}send('hold',{ids});},bar);
  button('선택 삭제',()=>confirmDelete(picked().map(x=>x.id),'검토 대기 후보'),bar,'mmc-danger');
  el('small',countText(),bar,'mmc-muted').dataset.selectedCount='true';
 }
 // Kind tabs: select-all covers what the current filter and search show (every page).
 function listBulk(parent,state,rows){
  const bar=el('div',undefined,parent,'lv-bulk');bar.dataset.bulk='list';
  const all=button('',()=>{ui.selected=new Set(visibleIn(rows,'list').map(x=>x.id));render();},bar);all.dataset.selectAll='list';
  const label=()=>{all.textContent='전체 선택 ('+visibleIn(rows,'list').length+'개)';};label();
  button('선택 해제',()=>{ui.selected.clear();render();},bar);
  const picked=()=>rows.filter(x=>ui.selected.has(x.id)).map(x=>x.id);
  button('선택 보류',()=>{const ids=picked();if(!ids.length){ui.note('보류할 항목을 먼저 고르세요.');return;}send('hold',{ids});},bar);
  button('선택 삭제',()=>confirmDelete(picked(),names[ui.tab]),bar,'mmc-danger');
  el('small',countText(),bar,'mmc-muted').dataset.selectedCount='true';
  return label;
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
  const inbox=card(grid,'검토 대기');inbox.dataset.queue='true';
  el('p',`새 후보 ${state.candidates.length}개 · 근거 재검토 ${review}개 · 보류 ${held}개`,inbox);
  if(state.candidates.length)el('p','‘승인’하면 모두가 아는 기억으로 저장되어 다음 답변부터 프롬프트에 들어갑니다. 넣고 싶지 않은 후보는 ‘비공개로 보관’하세요(저장만 하고 넣지 않음).',inbox,'lv-hint').dataset.approveHint='true';
  const pick=ui.queueLayer||'all',queueRows=()=>state.candidates.filter(x=>pick==='all'||x.layer===pick);
  queueBulk(inbox,state,queueRows);
  const layers=el('div',undefined,inbox,'lv-chips');
  for(const [id,name] of [['all','전체'],...tabs.slice(1)]){const n=id==='all'?state.candidates.length:state.candidates.filter(x=>x.layer===id).length;if(id!=='all'&&!n)continue;const b=button(name+' '+n,()=>{ui.queueLayer=id;ui.limits.queue=PAGE;ui.selected.clear();render();},layers,'mmc-chip'+(pick===id?' is-active':''));b.dataset.layer=id;}
  searchable(inbox,'queue','후보 검색',queueRows(),(x,list)=>itemRow(x,list,state,{slot:'queue',candidate:true,layer:true}),'검토할 후보가 없어요.');
  checkup(main,state);
  const recent=card(main,'최근 변화');
  const changed=[...state.items].sort((a,b)=>(b.lastChangedAt||0)-(a.lastChangedAt||0)).slice(0,5);
  const list=el('div',undefined,recent,'lv-list');for(const x of changed)itemRow(x,list,state,{slot:'recent',pick:false,layer:true});
  if(!state.items.length)el('p','아직 보관된 기억이 없어요. 종류별 탭에서 직접 추가하거나 상단의 분석으로 후보를 만들어 보세요.',recent,'mmc-muted');
 }
 // 점검: model-free diagnostics (always on) plus the optional model check and its proposals.
 function checkup(main,state){
  const c=card(main,'기억 점검');c.dataset.checkup='true';
  const rows=diagnose(state,ui.auto);
  if(!rows.length)el('p','모델 없이 확인한 문제는 없습니다.',c,'mmc-muted').dataset.diagnostics='clean';
  else{
   const list=el('ul',undefined,c,'lv-diag');list.dataset.diagnostics='true';
   for(const r of rows){
    const li=el('li',undefined,list);li.dataset.tone=r.tone;li.dataset.diag=r.key;
    if(!r.ids.length){el('span',r.text,li);continue;}
    const more=el('details',undefined,li);el('summary',r.text,more);
    for(const id of r.ids.slice(0,10)){const x=state.items.find(y=>y.id===id);if(!x)continue;
     button(names[x.layer]+' · '+title(x),()=>go(x.layer,x.id),more,'lv-title');}
    if(r.ids.length>10)el('small','외 '+(r.ids.length-10)+'개',more,'mmc-muted');
   }
  }
  const run=button(ui.checking?'점검 중…':'기억 점검 (모델)',()=>{
   if(!ui.connection){ui.note('설정 탭에서 모델 연결을 먼저 고르세요.');go('settings');return;}
   ui.checking=true;run.disabled=true;run.textContent='점검 중…';
   send('health',{mode:ui.mode||'raw',connection:ui.connection,timeZone:localTimeZone()});
  },c,'lv-run');run.dataset.run='health';run.disabled=!!ui.checking;
  el('small','누르면 비밀·인물 제한·보류를 뺀 현재 기억과 최근 대화 원문(합쳐서 '+MAX_INPUT_CHARS.toLocaleString('en-US')+'자까지)을 설정 탭의 모델 연결로 보내 중복·모순·해소된 상태·지켜진 약속·너무 긴 기억을 찾습니다. 루미버스 요약 참고가 켜져 있으면 남는 한도 안에서 이 채팅의 요약도 참고용으로 함께 보냅니다. 결과는 제안으로만 오고, 체크한 것만 적용합니다. 삭제는 제안하지 않습니다.',c,'mmc-muted');
  proposals(c,state);
 }
 const actionNames={update:'고쳐 쓰기',complete:'완료로',archive:'보관 (보류·주입 제외)'};
 function proposals(parent,state){
  const h=ui.health;if(!h?.proposals?.length)return;
  const box=el('div',undefined,parent,'lv-stack');box.dataset.health='true';
  el('h3','점검 제안 '+h.proposals.length+'개',box);
  el('small',[h.text,h.note].filter(Boolean).join(' · '),box,'mmc-muted');
  const conflictOf=p=>p.conflict||!sameBase(state.items.find(x=>x.id===p.targetId),p.base);
  const open=h.proposals.filter(p=>!conflictOf(p));
  for(const id of [...ui.healthSelected])if(!open.some(p=>p.id===id))ui.healthSelected.delete(id);
  const bar=el('div',undefined,box,'lv-bulk');
  button('제안 전체 선택',()=>{ui.healthSelected=new Set(open.map(p=>p.id));render();},bar);
  button('제안 선택 해제',()=>{ui.healthSelected.clear();render();},bar);
  for(const p of h.proposals){
   const x=state.items.find(y=>y.id===p.targetId),conflict=conflictOf(p);
   const a=el('article',undefined,box,'lv-item lv-proposal'+(conflict?' is-conflict':''));a.dataset.proposal=p.id;
   const line=el('div',undefined,a,'lv-line'),l=el('label',undefined,line,'lv-pick'),cb=el('input',undefined,l);
   cb.type='checkbox';cb.checked=!conflict&&ui.healthSelected.has(p.id);cb.disabled=conflict;cb.setAttribute('aria-label','제안 선택: '+actionNames[p.action]+' '+(x?title(x):''));
   cb.onchange=()=>{cb.checked?ui.healthSelected.add(p.id):ui.healthSelected.delete(p.id);};
   el('b',actionNames[p.action]+' · '+(layerNames[p.layer]||'')+' · '+(x?title(x):'(지워진 기억)'),line);
   if(conflict)el('p','충돌: 점검 뒤에 이 기억이 바뀌었거나 지워져 적용하지 않습니다. 다시 점검하세요.',a,'lv-warning');
   if(p.action==='update'){el('small','변경 전',a,'mmc-muted');el('pre',p.base.text,a);el('small','변경 후',a,'mmc-muted');el('pre',p.text,a);}
   else el('pre',p.base.text,a);
   if(p.reason)el('small','이유: '+p.reason,a,'mmc-muted');
  }
  const actions=el('div',undefined,box,'lv-actions');
  button('체크한 제안 적용',()=>{const ids=[...ui.healthSelected];if(!ids.length){ui.note('적용할 제안을 고르세요.');return;}send('healthApply',{ids});},actions,'mmc-primary').dataset.healthApply='true';
  button('점검 결과 닫기',async()=>{
   if(open.length&&!await confirm({title:'점검 결과 닫기',message:'적용하지 않은 제안 '+open.length+'개를 버립니다. 기억은 바뀌지 않습니다.',variant:'warning',confirmLabel:'닫기',cancelLabel:'취소'}))return;
   send('healthDismiss');
  },actions).dataset.healthDismiss='true';
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
  if(pick){const l=el('label',undefined,line,'lv-pick'),c=el('input',undefined,l);c.type='checkbox';c.checked=ui.selected.has(x.id);c.setAttribute('aria-label','선택: '+title(x));c.onchange=()=>{c.checked?ui.selected.add(x.id):ui.selected.delete(x.id);recount();};}
  const t=button(title(x),()=>{ui.detail=open?null:key;render();},line,'lv-title');t.setAttribute('aria-expanded',String(open));
  const risks=candidate?candidateRisks(x):[];
  el('small',[layer?names[x.layer]:'',candidate?'승인 대기':explain(x),risks.length?'직접 확인: '+risks.join('·'):''].filter(Boolean).join(' · '),article,'lv-meta');
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
  const isCandidate=state.candidates.some(y=>y.id===x.id);
  if(isCandidate){
   const risks=candidateRisks(x),restricted=['secret','character'].includes(x.scope);
   if(risks.length)el('p','직접 확인이 필요한 후보입니다: '+risks.join(', ')+'. 일괄 승인에서는 빠집니다.',reader,'lv-warning');
   const decide=el('div',undefined,c,'lv-actions');decide.dataset.decide=x.id;
   if(!restricted)button('승인 · 프롬프트에 넣기',()=>send('approve',{ids:[x.id],scope:'public',confirmPublic:true}),decide,'mmc-primary').dataset.approve='public';
   button(restricted?'승인 (범위 유지·주입 안 함)':'비공개로 보관',()=>send('approve',{ids:[x.id],scope:'unknown'}),decide).dataset.approve='unknown';
  }else if((x.scope||'unknown')==='unknown'&&!x.knownBy?.length&&!x.audience&&!x.condition){
   const promote=el('div',undefined,c,'lv-actions');
   el('small','비공개라 프롬프트에 넣지 않는 기억입니다.',promote,'mmc-muted');
   button('모두가 아는 기억으로 (주입)',()=>send('put',{item:{...x,scope:'public'},confirmPublic:true}),promote,'mmc-primary').dataset.promote=x.id;
  }
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
  const filters=el('div',undefined,left,'mmc-seg');for(const [id,name] of hasLifecycle(ui.tab)?[['active','진행 중'],['hold','보류'],['done','완료'],['all','전체']]:[['hold','보류'],['all','전체']])button(name,()=>{ui.filter=id;ui.limits.list=PAGE;ui.selected.clear();render();},filters,'mmc-filter'+(ui.filter===id?' is-active':''));
  const rows=[...state.items,...state.candidates].filter(x=>x.layer===ui.tab&&(ui.filter==='all'||ui.filter==='hold'&&(x.hold||x.branchHold||x.importedScope)||ui.filter==='done'&&['completed','cancelled'].includes(x.status)||ui.filter==='active'&&!x.hold&&x.status==='active'));
  el('small',names[ui.tab]+' '+rows.length+'개 · 눌러서 펼치기',left,'mmc-muted');
  const relabel=listBulk(left,state,rows);
  searchable(left,'list','기억 검색',rows,(x,list)=>itemRow(x,list,state,{candidate:state.candidates.includes(x)}),'아직 이 종류의 기억이 없어요. 직접 추가하거나 원문에서 정리해 보세요.',relabel);
  if(ui.tab==='anchors')el('p','항상 기억할 공개 앵커만 지원합니다. 원작의 키워드 호출·주입 예산은 아직 지원하지 않습니다.',main,'lv-warning');
  if(ui.tab==='scenes'||ui.tab==='flows'||ui.tab==='elements'||ui.tab==='wiki')el('p','이 버전은 텍스트 중심 편집입니다. 원작의 구조화 장면·흐름별 이력·요소 검색 조건·위키 자동 갱신은 아직 지원하지 않습니다.',main,'lv-warning');
 }
 function editor(main,state){
  const draft=ui.editor,c=card(main,'기억 편집');
  const heading=row(c);button('목록으로',()=>{ui.editor=null;render();},heading,'mmc-ghost');
  const t=field('제목','input',c,draft.title||''),text=field('내용','textarea',c,draft.text);
  const layer=select('기억 종류',tabs.slice(1),c,draft.layer),scope=select('공개 범위',[['unknown','비공개 (주입 안 함)'],['public','모두가 아는 기억'],['secret','비밀 (주입 안 함)'],['character','인물 제한 (주입 안 함)']],c,draft.scope);
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
  let add=null,addHint=null;
  const number=(parent,label,value,set)=>{const x=el('input',undefined,parent);x.type='text';x.setAttribute('inputmode','numeric');x.setAttribute('pattern','[0-9]*');x.setAttribute('aria-label',label);x.value=String(value??'');x.oninput=()=>{set(x.value.replace(/[^0-9]/g,''));update();};x.onchange=()=>{x.value=x.value.replace(/[^0-9]/g,'');};return x;};
  if(src.scope==='last'){const l=el('label',undefined,box,'lv-num');el('span','최근',l);number(l,'최근 메시지 개수',src.n,v=>src.n=v);el('span','개 메시지',l);}
  else{
   const list=el('div',undefined,box,'lv-ranges');
   for(const [k,r] of src.ranges.entries()){
    const line=el('div',undefined,list,'lv-range');line.dataset.range=String(k);
    number(line,'범위 '+(k+1)+' 시작',r.start,v=>r.start=v);el('span','–',line);number(line,'범위 '+(k+1)+' 끝',r.end,v=>r.end=v);
    button('×',()=>{src.ranges.splice(k,1);render();},line,'mmc-ghost lv-x').setAttribute('aria-label','범위 '+(k+1)+' 삭제');
   }
   if(src.ranges.length<MAX_RANGES){
    // Continues from the last row (start = its end + 1, same length, clamped to the chat).
    add=button('+ 범위 추가',()=>{if(ui.analyzing)return;const n=src.ranges.length?nextRange(src.ranges.at(-1),count?.total):defaultRange();if(!n)return;src.ranges.push(n);render();},list,'lv-add');
    addHint=el('small',undefined,list,'mmc-muted');addHint.dataset.addHint='';
   }
  }
  const summary=el('p',undefined,c,'lv-source-summary'),warn=el('p',undefined,c,'lv-warning');
  const total=el('small',undefined,c,'mmc-muted');
  const profile=ui.connections.find(x=>x.id===ui.connection);
  const model=el('small',ui.connection?'모델: '+(profile?profile.name+' · '+(profile.model||'(모델 미지정)'):'선택한 연결')+' · '+(ui.mode||'raw'):'모델 연결이 아직 없습니다. 설정 탭에서 고르세요.',c,ui.connection?'mmc-muted':'lv-warning');model.dataset.model=ui.connection?'set':'none';
  const run=button(ui.analyzing?(ui.batch?batchLabel(ui.batch):'분석 중…'):'분석',()=>{
   if(ui.analyzing)return;
   const s=update();if(!s.ok){ui.note(s.error);return;}
   if(!ui.connection){ui.note('설정 탭에서 모델 연결을 먼저 고르세요.');go('settings');return;}
   const opts={mode:ui.mode||'raw',connection:ui.connection,timeZone:localTimeZone()};
   // Separate ranges are analyzed one model call each, in order (recent N is one call).
   const spans=src.scope==='range'?(s.spans||resolveScope({scope:'range',ranges:src.ranges},Number.MAX_SAFE_INTEGER).spans||[]):[];
   ui.analyzing=true;run.disabled=true;if(add)add.disabled=true;
   if(spans.length>1){ui.batch={id:crypto.randomUUID(),spans,index:0,ok:[],fail:[],opts};run.textContent=batchLabel(ui.batch);sendSpan(ui.batch);ui.note(ui.status);return;}
   run.textContent='분석 중…';
   send('analyze',{source:src.scope==='last'?{scope:'last',n:src.n}:{scope:'range',ranges:src.ranges.map(r=>({start:r.start,end:r.end}))},...opts});
  },c,'mmc-primary lv-run');run.dataset.run='analyze';run.setAttribute('aria-label','분석 실행');
  el('small','누르면 고른 범위의 원문을 설정한 모델로 바로 보냅니다(한 번에 '+MAX_INPUT_CHARS.toLocaleString('en-US')+'자까지). 비밀이 담긴 대화는 범위에서 빼세요. 루미버스 요약 참고가 켜져 있으면 이 채팅의 요약도 참고용으로 함께 보냅니다. 결과는 후보로만 들어가고 자동 승인하지 않습니다.',c,'mmc-muted');
  const queue=row(c);el('span','검토 대기 후보 '+state.candidates.length+'개',queue);button('검토 대기 열기',()=>go('overview'),queue,'mmc-sm');
  function update(){
   const s=!chatId?{ok:false,error:'채팅을 먼저 여세요.'}:count?sourceSummary(src.scope==='last'?{scope:'last',n:src.n}:{scope:'range',ranges:src.ranges},count.total,count.hidden):{ok:true,pending:true};
   // The service reports the summary option per chat (on/off and at most how much is sent).
   const loom=ui.loom?.enabled?' · '+(ui.loom.chars?'루미버스 요약 참고 ('+ui.loom.chars.toLocaleString('en-US')+'자)':'요약 없음'):'';
   summary.textContent=s.pending?'대화 개수 확인 중…':s.ok?s.text+loom:'분석할 대화 없음';summary.dataset.sourceSummary=s.ok&&!s.pending?'ok':s.pending?'pending':'error';
   const notes=s.ok?(s.warnings||[]):[s.error];warn.textContent=notes.join(' ');warn.hidden=!notes.length;
   total.textContent=count?'전체 '+count.total+'개'+(count.hidden.length?' · 숨김 '+count.hidden.length+'개는 분석에서 빠집니다':'')+' · 번호는 채팅 순서 기준':'';
   run.disabled=!!ui.analyzing||(!s.ok&&!s.pending);
   if(add){
    const last=src.ranges.at(-1),next=src.ranges.length?nextRange(last,count?.total):{};
    add.disabled=!!ui.analyzing||!next;
    const r=last&&count?rangeStatus(last,count.total):null;
    addHint.textContent=!next&&r?.ok&&Math.max(r.start,r.end)>=count.total?'마지막 범위가 대화 끝('+count.total+')까지라 이어서 추가할 범위가 없습니다.':'';addHint.hidden=!addHint.textContent;
   }
   return s.pending?{ok:true}:s;
  }
  const refresh=button('대화 개수 새로고침',()=>send('count'),c,'mmc-ghost mmc-sm');refresh.dataset.count='refresh';
  update();
 }
 // Several ranges: one 'analyze' request per span, sent one after another. A failed span
 // is recorded and the run moves on; the last reply writes a per-range summary.
 const batchLabel=b=>'범위 '+(b.index+1)+'/'+b.spans.length+' 분석 중…';
 const sendSpan=(b,revision)=>{const [a,z]=b.spans[b.index];ui.status=batchLabel(b)+' ('+spanLabel([[a,z]])+')';send('analyze',{source:{scope:'range',ranges:[{start:String(a),end:String(z)}]},...b.opts,...(revision>=0?{revision}:{})},{batch:b.id});};
 function batchStep(reply){
  const b=ui.batch,label=spanLabel([b.spans[b.index]]);
  if(reply.ok)b.ok.push(Number.isSafeInteger(reply.added)?reply.added:0);else b.fail.push('범위 '+(b.index+1)+' ('+label+') – '+String(reply.error||'알 수 없는 오류'));
  b.index++;
  // The reply's state is accepted only after this step, so its revision is passed on.
  if(b.index<b.spans.length){sendSpan(b,Math.max(-1,...[reply.ok?reply.state?.revision:null,get().state?.revision].filter(Number.isSafeInteger)));return false;}
  ui.batch=null;ui.analyzing=false;
  const added=b.ok.reduce((n,x)=>n+x,0);
  ui.status=b.spans.length+'개 범위 중 '+b.ok.length+'개 성공'+(b.ok.length?' (후보 '+added+'개 추가)':'')+(b.fail.length?', 실패: '+b.fail.join(' / '):'')+(b.ok.length?' · 검토 대기에서 확인 후 승인하세요':'');
  if(b.ok.length)ui.tab='overview';
  return true;
 }
 const defaultRange=()=>{const t=ui.counts[get().chatId||'']?.total||0;return t?{start:String(Math.max(1,t-DEFAULT_RECENT+1)),end:String(t)}:{start:'1',end:String(DEFAULT_RECENT)};};
 function analysisSettings(main){
  const c=card(main,'분석 설정');
  if(!ui.connections.length&&!ui.connectionsAsked){ui.connectionsAsked=true;send('connections');}
  const mode=select('분석 모드',[['raw','직접 분석 (raw)'],['quiet','프리셋 적용 (quiet)']],c,ui.mode||'raw');mode.onchange=()=>ui.mode=mode.value;
  const connection=select('모델 연결',[['','연결을 선택하세요'],...ui.connections.map(x=>[x.id,x.name+' · '+(x.model||'(모델 미지정)')])],c,ui.connection||'');connection.onchange=()=>ui.connection=connection.value;
  button('모델 목록 새로고침',()=>send('connections'),c,'mmc-sm');
  el('p','분석 버튼을 누르면 고른 범위의 원문이 이 연결로 바로 전송됩니다. 비밀이 담긴 대화는 범위에서 빼세요. 모델 결과는 후보로만 들어가며 자동 승인하지 않습니다. 선택은 패널을 다시 불러오기 전까지 유지됩니다.',c,'lv-warning');
  // Lumiverse's own chat summary as reference. Saved on the server for all chats. Opt-in: off until the user turns it on.
  const loom=check('루미버스 요약(Loom) 참고 (선택)',c,ui.loom?.enabled===true);loom.dataset.loom='toggle';
  loom.onchange=()=>send('loomSettings',{enabled:loom.checked});
  el('small','기본 꺼짐. 직접 켤 때만 분석·자동 분석·기억 점검 때 루미버스가 이 채팅에 저장한 요약(Summary)을 원문 뒤에 참고용으로 함께 보냅니다. 끈 상태에서는 요약을 보내지 않습니다. 최대 '+LOOM_CAP.toLocaleString('en-US')+'자, 넘으면 앞부분을 자르고, 원문을 먼저 채운 뒤 남는 한도만 씁니다. 요약은 날짜·흐름 참고용이며 후보는 고른 원문에서만 뽑고, 원문과 다르면 원문이 우선합니다. 요약은 기억으로 저장하지 않습니다. 모든 채팅에 공통입니다.',c,'mmc-muted');
  el('p','요약에는 고른 범위 밖의 대화 내용도 담겨 있습니다. 요약에 비밀이 들어 있다면 켜지 마세요.',c,'lv-warning');
  autoSettings(main);
 }
 // Per-chat automatic analysis. Saved on the server apart from memories (no undo step).
 function autoSettings(main){
  const a=ui.auto||{enabled:false,every:10},c=card(main,'자동 분석');c.dataset.autoSettings='true';
  const toggle=check('사용자 메시지 N개마다 자동 분석',c,!!a.enabled);
  if(!a.enabled&&!ui.connection){toggle.disabled=true;el('small','켜려면 위에서 모델 연결을 먼저 고르세요.',c,'mmc-muted');}
  const l=el('label',undefined,c,'lv-num');el('span','사용자 메시지',l);const n=el('input',undefined,l);n.type='text';n.setAttribute('inputmode','numeric');n.setAttribute('pattern','[0-9]*');n.setAttribute('aria-label','자동 분석 간격');n.value=String(a.every||10);n.oninput=()=>{n.value=n.value.replace(/[^0-9]/g,'');};el('span','개마다 (3–100)',l);
  el('p','켜면 마지막 자동 분석 뒤의 대화 원문(한 번에 '+MAX_INPUT_CHARS.toLocaleString('en-US')+'자까지)이 위에서 고른 모델 연결로 자동 전송됩니다. 루미버스 요약 참고가 켜져 있으면 이 채팅의 요약도 남는 한도 안에서 함께 보냅니다.',c,'lv-warning');
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
  const info=card(main,'이식 범위와 권한');el('p','Lumiverse 테마를 따릅니다. chats·chat_mutation은 소유권/원문 조회, generation은 사용자가 누른 분석·기억 점검과 켜 둔 자동 분석, interceptor는 생성 직전 기억 주입에 사용합니다. 메시지는 수정하지 않습니다.',info);
  el('p','인물 매핑·주입 예산·키워드 조건·흐름별 이력·구조화 장면·원본 데이터 변환·로어북 동기화·Keeper는 지원하지 않습니다. 가짜 설정은 표시하지 않습니다.',info,'lv-warning');
  el('p','영구 책을 만들지 않습니다. 과거 수동 내보내기 책은 호스트에서 직접 연결 해제·삭제하세요. 확장 비활성화는 데이터를 남깁니다. 제거 전 JSON을 내보내세요.',info);
 }
 function render(){
  // The drawer scrolls the whole panel; rebuild synchronously with no layout reads so its scroll position is kept.
  const {state,chatId,recovery}=get();root.replaceChildren();root.className='memory-cabinet';root.id='mmc-root-v1';el('style',vaultStyle+'\n'+theme);
  const overlay=el('div',undefined,root,'mmc-overlay'),shell=el('section',undefined,overlay,'mmc-shell');
  const bar=el('header',undefined,shell,'mmc-bar'),brand=el('div',undefined,bar,'mmc-brand');el('span','▤',brand,'mmc-brand-mark');const bt=el('span',undefined,brand,'mmc-brand-text');el('b','기억 보관함',bt);el('small','MEMORY VAULT · 0.3 BETA',bt);
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
 return {render,batchStep};
}

export function setup(ctx){
 const tab=ctx.ui.registerDrawerTab({id:'cabinet',title:'기억 보관함',shortName:'기억',description:'승인 중심 기억 편집'}),root=tab.root;
 let epoch=0,serial=0,accepted=0,chatId=null,state=null,recovery=false,alive=true;
 const pending=new Map();
 const ui={tab:'overview',filter:'all',selected:new Set(),connections:[],status:'',editor:null,transfer:'',sourceByChat:{},counts:{},countAsked:null,analyzing:false,batch:null,checking:false,health:null,healthSelected:new Set(),limits:{},queries:{},queueLayer:'all',detail:null};
 const note=message=>{ui.status=message;const n=root.querySelector('[role=status]');if(n)n.textContent=message;};
 ui.note=note;
 const send=(type,extra={},meta={})=>{const requestId=crypto.randomUUID();pending.set(requestId,{...meta,epoch,type,sequence:++serial});ctx.sendToBackend({requestId,type,chatId,revision:state?.revision,...extra});};
 // Host confirmation dialog (Lumiverse 1.2.5 ctx.ui.showConfirm); dismissing it cancels.
 const confirm=async options=>{
  if(typeof ctx.ui.showConfirm==='function'){try{return (await ctx.ui.showConfirm(options))?.confirmed===true;}catch{return false;}}
  return typeof globalThis.confirm==='function'?!!globalThis.confirm(options.message):true;
 };
 const view=createView(root,{send,get:()=>({chatId,state,recovery}),ui,confirm});
 const offMessage=ctx.onBackendMessage(reply=>{
  // Automatic analysis finished in the background: refresh the open chat only.
  if(reply?.event==='autoAnalysis'&&!reply.requestId){if(alive&&reply.chatId&&reply.chatId===chatId){ui.auto=reply.auto||null;send('load');}return;}
  const p=pending.get(reply.requestId);pending.delete(reply.requestId);
  if(!alive||!p||p.epoch!==epoch)return;
  // A reply in a multi-range run records that range and sends the next one first, so
  // a failed or stale reply never stops the run.
  const batch=p.type==='analyze'&&!!p.batch&&ui.batch?.id===p.batch;
  if(p.type==='analyze'&&!batch)ui.analyzing=false;
  if(p.type==='health')ui.checking=false;
  if(batch)view.batchStep(reply);
  if(!reply.ok){if(!batch)note(reply.error);if(['analyze','health'].includes(p.type))view.render();return;}
  if(!reply.recovery&&state&&reply.state.revision<state.revision&&!['reset','restoreBackup'].includes(p.type)){if(batch)view.render();return;}
  if(p.sequence<accepted&&(reply.recovery||state&&reply.state?.revision===state.revision)){if(batch)view.render();return;}
  accepted=Math.max(accepted,p.sequence);chatId=reply.chatId;state=reply.state;recovery=!!reply.recovery;ui.injection=reply.injection||null;
  if(Number.isSafeInteger(reply.total)&&Array.isArray(reply.hidden))ui.counts[reply.chatId]={total:reply.total,hidden:reply.hidden.filter(Number.isSafeInteger)};
  if(reply.connections)ui.connections=reply.connections;
  if(reply.loom&&typeof reply.loom.enabled==='boolean')ui.loom={enabled:reply.loom.enabled,chars:Number.isSafeInteger(reply.loom.chars)?reply.loom.chars:0};
  if(reply.auto){ui.auto=reply.auto;if(reply.auto.enabled&&!ui.connection){ui.connection=reply.auto.connection;ui.mode=reply.auto.mode;}}
  if('health' in reply){const prev=ui.health,h=reply.health||null;ui.health=h;
   const open=(h?.proposals||[]).filter(x=>!x.conflict).map(x=>x.id);
   ui.healthSelected=new Set(h&&prev&&prev.at===h.at?open.filter(id=>ui.healthSelected.has(id)):open);}
  if(reply.json){ui.transfer=reply.json;ui.tab='settings';}
  if(reply.saved){ui.editor=null;if(p.type==='analyze'&&!batch)ui.tab='overview';}
  if(p.type==='health'&&reply.health)ui.tab='overview';
  if(['reset','restoreBackup'].includes(p.type)){epoch++;pending.clear();ui.analyzing=false;ui.batch=null;ui.selected.clear();ui.editor=null;ui.limits={};ui.queries={};ui.queueLayer='all';ui.detail=null;ui.health=null;ui.healthSelected.clear();ui.checking=false;}
  if(!batch)ui.status=reply.notice||(reply.saved?'저장 완료':reply.output||'불러오기 완료');
  view.render();
 });
 const offSwitch=ctx.events.on('CHAT_SWITCHED',p=>{
  epoch++;chatId=p.chatId||null;state=null;recovery=false;pending.clear();
  ui.countAsked=null;ui.analyzing=false;ui.batch=null;ui.selected.clear();ui.editor=null;ui.limits={};ui.queries={};ui.queueLayer='all';ui.detail=null;ui.transfer='';ui.status='';ui.injection=null;ui.auto=null;ui.loom=null;ui.health=null;ui.healthSelected.clear();ui.checking=false;
  view.render();if(chatId)send('load');
 });
 view.render();send('load');
 return ()=>{alive=false;epoch++;pending.clear();offMessage();offSwitch();root.replaceChildren();tab.destroy();};
}