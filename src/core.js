export const layers=['promises','anchors','elements','scenes','flows','wiki'];
export const layerNames={promises:'약속',anchors:'기억 앵커',elements:'요소 기억',scenes:'장면 기억',flows:'진행 흐름',wiki:'이야기 위키'};
export const injectionText=items=>items.map(x=>layerNames[x.layer]+': '+x.text).join('\n');
export const empty=()=>({version:1,revision:0,items:[],candidates:[],undo:[]});
export const clone=x=>JSON.parse(JSON.stringify(x));
// Random ids that also work outside secure contexts. crypto.randomUUID exists only on HTTPS or localhost, so a
// phone that opens Lumiverse over plain http (e.g. http://100.x.y.z:7860 on Tailscale) does not have it.
// crypto.getRandomValues is available everywhere, so it builds the same RFC 4122 version 4 string;
// Math.random is the last resort for hosts without Web Crypto at all.
const uuidHex=Array.from({length:256},(_,i)=>i.toString(16).padStart(2,'0'));
export function uuid(){
 const c=globalThis.crypto;
 if(typeof c?.randomUUID==='function')return c.randomUUID();
 const b=new Uint8Array(16);
 if(typeof c?.getRandomValues==='function')c.getRandomValues(b);
 else for(let i=0;i<16;i++)b[i]=Math.floor(Math.random()*256);
 b[6]=0x40|(b[6]&0x0f);b[8]=0x80|(b[8]&0x3f);
 const h=[...b].map(n=>uuidHex[n]);
 return `${h.slice(0,4).join('')}-${h.slice(4,6).join('')}-${h.slice(6,8).join('')}-${h.slice(8,10).join('')}-${h.slice(10).join('')}`;
}
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
// One JSON object (scene record / merge responses) with the same boundary rules as
// parseCandidates: whole-response JSON first, then the first balanced object after
// leading reasoning or prose. `field` must be present on the object that is accepted.
export function parseObject(content,field){
 const raw=String(typeof content==='string'?content:'').trim();
 const fail=()=>Error('모델 응답을 JSON 객체로 해석하지 못했습니다. 응답이 잘렸거나 형식이 다릅니다. 다시 기록하거나 다른 모델·모드를 고르세요. 응답 앞부분: '+(raw.slice(0,120)||'(빈 응답)')+(raw.length>120?'…':''));
 const usable=v=>v&&typeof v==='object'&&!Array.isArray(v)&&field in v?v:null;
 if(content&&typeof content==='object'&&!Array.isArray(content)){const v=usable(safe(content));if(v)return v;throw fail();}
 if(typeof content!=='string')throw Error('모델 응답 형식 오류: 텍스트 응답이 아닙니다. 다시 시도하세요.');
 if(new TextEncoder().encode(content).byteLength>MAX_RESPONSE_BYTES)throw Error('크기 제한 2MB');
 const whole=tryParse(raw);if(whole){const v=usable(whole.value);if(v)return v;throw fail();}
 const text=raw.replace(/^(\s*<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\2>)+/i,'').trim();
 for(let i=text.indexOf('{');i>=0;){
  const end=balancedValue(text,i);if(end<0)break;
  const r=tryParse(text.slice(i,end)),v=r&&usable(r.value);if(v)return v;
  i=text.indexOf('{',end);}
 throw fail();
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

 else if(c.type==='delete'){
  // Every ID must exist in this chat: a selection made in another chat (or before a
  // reload) is refused as a whole instead of deleting whatever happens to share an ID.
  if(!Array.isArray(c.ids)||!c.ids.length)throw Error('삭제 대상 형식 오류');
  const known=new Set([...s.items,...s.candidates].map(x=>x.id));if(c.ids.some(id=>!known.has(id)))throw Error('삭제 대상 불일치: 이 채팅에 없는 항목이 포함됨. 새로고침 후 다시 고르세요.');
  s.items=s.items.filter(x=>!c.ids.includes(x.id));s.candidates=s.candidates.filter(x=>!c.ids.includes(x.id));}
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
   // Same gates as candidate approval: a locked wiki or a held / restricted memory is never changed by the model.
   if(x.locked)throw Error('위키 잠금: 먼저 수동 해제');if(!healthEligible(x))throw Error('점검 대상이 보류·제한 상태라 바꿀 수 없음');
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
// as the host orders it; hidden messages keep their slot and are analyzed like any other
// (a chat whose turns were hidden to save context must still fit into the vault).
// The panel only knows the message count and hidden positions, never bodies: it shows
// a summary with sourceSummary(), and the service resolves the same scope against the
// host messages with selectSource() when the user presses analyze.
export const MAX_INPUT_CHARS=60000;
// One line naming the messages (1-based numbers) skipped for being over the input limit.
export const skipNote=list=>list?.length?'건너뛴 대화 '+list.slice(0,20).join(', ')+(list.length>20?' 외 '+(list.length-20)+'개':'')+'(메시지 하나가 '+MAX_INPUT_CHARS.toLocaleString('en-US')+'자 한도 초과 · 잘라 보내지 않음)':'';
export const MAX_RANGES=20;
export const DEFAULT_RECENT=20;
// Strict: a safe integer number, or a string of ASCII digits (surrounding spaces only).
// Anything else (1.5, -1, 1e1, 0x10, 15abc) is NaN, so it is reported and never turned
// into some other, valid-looking number.
export const strictInt=x=>typeof x==='number'?(Number.isSafeInteger(x)?x:NaN):typeof x==='string'&&/^\s*[0-9]{1,15}\s*$/.test(x)?Number(x):NaN;
const int=strictInt;
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
// Panel status for a multi-range run: one short summary line plus details (one line
// per range note or failure) shown only when the user expands it.
const shortReason=e=>String(e||'알 수 없는 오류').split(/[:.(\n]/)[0].trim().slice(0,30)||'알 수 없는 오류';
export function batchSummary({total,ok,added=null,fails=[],notes=[],noun='범위',done='분석 완료',next='검토 대기에서 확인 후 승인하세요'}){
 const reasons=[...new Set(fails.map(f=>shortReason(f.error)))];
 const tally=added===null?'':' (후보 '+added+'개 추가)';
 const summary=fails.length&&!ok?total+'개 '+noun+' 모두 실패'+(reasons.length===1?' — '+reasons[0]:'')
  :fails.length?total+'개 '+noun+' 중 '+ok+'개 성공'+tally+' · '+fails.length+'개 실패'+(reasons.length===1?' ('+reasons[0]+')':'')
  :total+'개 '+noun+' '+done+tally;
 return {summary:summary+(ok&&next?' · '+next:''),detail:[...notes.filter(Boolean),...fails.map(f=>f.label+' – '+String(f.error||'알 수 없는 오류'))].join('\n')};
}
export const spanLabel=spans=>'대화 '+spans.map(([a,b])=>a===b?String(a):a+'–'+b).join(', ');
// Panel summary from the count only: "대화 120–141 (22개, 숨김 5개 포함)".
export function sourceSummary(scope,total,hidden=[]){
 const r=resolveScope(scope,total);if(!r.ok)return r;
 const inSpan=n=>r.spans.some(([a,b])=>n>=a&&n<=b);
 const count=r.spans.reduce((n,[a,b])=>n+b-a+1,0),hiddenIn=[...new Set(hidden)].filter(inSpan).length;
 return {...r,count,hiddenIn,text:spanLabel(r.spans)+' ('+count+'개'+(hiddenIn?', 숨김 '+hiddenIn+'개 포함':'')+')'};
}
// Service side: the same scope resolved against the host's current messages.
export function selectSource(messages,scope){
 const {total,hidden}=countOf(messages),s=sourceSummary(scope,total,hidden);if(!s.ok)throw Error(s.error);
 const picked=messages.map((m,index)=>({m,index})).filter(({index})=>s.spans.some(([a,b])=>index+1>=a&&index+1<=b));
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
const sourceHeader=zone=>'[메시지 전송 시각 기준: '+(validTimeZone(zone)||'UTC (사용자 시간대 미확인)')+']';
const sourceLine=(m,zone)=>{const t=sentStamp(m,validTimeZone(zone));return (t?'[전송 '+t+'] ':'[전송 시각 미상] ')+String(m.content??'');};
export function sourceInput(messages,zone){
 if(!messages.length)return '';
 return [sourceHeader(zone),...messages.map(m=>sourceLine(m,zone))].join('\n\n');
}
// A span too large for one call, split at message boundaries into consecutive chunks
// whose sourceInput() each fits `limit` (oldest first). A message that cannot fit even
// alone is never cut: it is returned in `skipped` and the chunks run around it.
// items: [{m,index}] in chat order.
export function splitForInput(items,zone,limit=MAX_INPUT_CHARS){
 const head=sourceHeader(zone).length,chunks=[],skipped=[];let cur=[],len=head;
 for(const it of items){
  const size=2+sourceLine(it.m,zone).length;
  if(head+size>limit){if(cur.length){chunks.push(cur);cur=[];len=head;}skipped.push(it);continue;}
  if(cur.length&&len+size>limit){chunks.push(cur);cur=[];len=head;}
  cur.push(it);len+=size;
 }
 if(cur.length)chunks.push(cur);
 return {chunks,skipped};
}
// "대화 1–30 → 1–12, 13–24, 25–30으로 나눠" plus skipped single messages.
export const chunkSpan=chunk=>[chunk[0].index+1,chunk.at(-1).index+1];
export const splitNote=(label,split,verb='분석')=>{
 const parts=split.chunks.map(c=>{const [a,b]=chunkSpan(c);return a===b?String(a):a+'–'+b;});
 return [split.chunks.length>1?label+' → '+parts.join(', ')+'으로 나눠 '+verb:'',split.skipped.length?'메시지 '+split.skipped.map(x=>x.index+1).join(', ')+'은 하나만으로 '+MAX_INPUT_CHARS.toLocaleString('en-US')+'자 한도를 넘어 건너뜀(잘라 보내지 않음)':''].filter(Boolean).join(' · ');
};
// Lumiverse's own chat summary (Loom Summary): one text per chat, stored by the host in
// chat.metadata.loom_summary (read through chats.get, the existing `chats` permission).
// Reference only, never a memory: it goes after the raw input, only into the room the
// raw input leaves under MAX_INPUT_CHARS, capped at LOOM_CAP and cut from the start so
// the most recent part stays. Untrusted text: non-strings and anything over 2MB read as
// no summary, control characters are dropped and block markers removed so it can never
// close its own block.
export const LOOM_CAP=8000,LOOM_MIN=200;
const LOOM_HEAD='\n\n[루미버스 요약]\n',LOOM_TAIL='\n[/루미버스 요약]',LOOM_CUT='…(앞부분 생략)\n';
export function loomText(chat){
 const v=chat?.metadata?.loom_summary;
 if(typeof v!=='string'||new TextEncoder().encode(v).byteLength>2000000)return '';
 return v.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/\[\s*\/?\s*(?:LUMIVERSE\s+SUMMARY|루미버스\s*요약)[^\]\n]*\]/gi,'').trim();
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
// Sent to the model and changeable by a proposal: not secret / character-limited /
// conditional, not held in any way (hold, branch hold, imported scope, resume required:
// the same set candidateRisks calls 보류) and not a locked wiki. Re-checked at apply time.
export const healthEligible=x=>!!x&&!x.knownBy?.length&&!x.audience&&!x.condition&&!['secret','character'].includes(x.scope)&&!x.hold&&!x.branchHold&&!x.importedScope&&!x.resumeRequired&&!x.locked;
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
 if(auto?.last?.ok&&auto.last.skipped?.length)rows.push({key:'auto',text:'자동 분석 일부 건너뜀: '+skipNote(auto.last.skipped)+' · 나머지는 분석했습니다',tone:'warn',ids:[]});
 if(auto?.last&&auto.last.ok===false)rows.push({key:'auto',text:'자동 분석 마지막 실행 실패: '+String(auto.last.error||'알 수 없는 오류')+(auto.last.skipped?.length?' · '+skipNote(auto.last.skipped):''),tone:'warn',ids:[]});
 return rows;
}
