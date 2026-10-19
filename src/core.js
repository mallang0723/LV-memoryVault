export const layers=['promises','anchors','elements','scenes','flows','wiki'];
export const layerNames={promises:'약속',anchors:'기억 앵커',elements:'요소 기억',scenes:'장면 기억',flows:'진행 흐름',wiki:'이야기 위키'};
export const injectionText=items=>items.map(x=>layerNames[x.layer]+': '+x.text).join('\n');
export const empty=()=>({version:1,revision:0,items:[],candidates:[],undo:[]});
export const clone=x=>JSON.parse(JSON.stringify(x));
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
const unwrapCandidates=v=>Array.isArray(v)?v:v&&typeof v==='object'?['candidates','memories','items'].map(k=>v[k]).find(Array.isArray):undefined;
const parseFail=content=>{const head=content.trim().slice(0,120);return Error('모델 응답을 JSON 배열로 해석하지 못했습니다. 응답이 잘렸거나 형식이 다릅니다. 다시 시도하거나 다른 모델·모드를 선택하세요. 응답 앞부분: '+(head||'(빈 응답)')+(content.trim().length>120?'…':''));};
const tryParse=text=>{try{return {value:safe(text)};}catch(error){if(error instanceof SyntaxError)return null;throw error;}};
// Scan prose for the first top-level JSON value. A region that is balanced but not
// usable is skipped as a whole (never searched inside); an unbalanced one ends the scan.
function locate(text){
 for(let i=text.search(/[[{]/);i>=0;){
  const end=balancedValue(text,i);if(end<0)return {truncated:true};
  const r=tryParse(text.slice(i,end)),list=r&&unwrapCandidates(r.value);if(list)return {list};
  const next=text.slice(end).search(/[[{]/);i=next<0?-1:end+next;}
 return {};
}
export function parseCandidates(content){
 if(Array.isArray(content))return safe(content);
 if(typeof content!=='string')throw Error('모델 응답 형식 오류: 텍스트 응답이 아닙니다. 다시 시도하세요.');
 if(new TextEncoder().encode(content).byteLength>MAX_RESPONSE_BYTES)throw Error('크기 제한 2MB');
 const whole=tryParse(content.trim());
 if(whole){const list=unwrapCandidates(whole.value);if(list)return list;throw parseFail(content);}
 let text=content.trim().replace(/^(\s*<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\2>)+/i,'').trim();
 let found=locate(text);
 // Reasoning leaked without its opening tag: only when the response does not itself
 // start with JSON or a fence, retry after the stray closing tag.
 if(!found.list&&!/^[[{`]/.test(text)){const stray=text.search(/<\/(think|thinking|reasoning)>/i);if(stray>=0)found=locate(text.slice(text.indexOf('>',stray)+1).trim());}
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
export const selectSafeCandidates=items=>publicItems({items}).filter(x=>!x.targetId&&!x.review&&!x.duplicate&&!x.resumeRequired).map(x=>x.id);
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
  for(const id of c.ids){const v=s.candidates.find(x=>x.id===id);if(!v)continue;
   const old=s.items.find(x=>x.id===v.targetId);
   if(old?.locked)throw Error('위키 잠금: 먼저 수동 해제');
   if(v.hold||v.branchHold||v.resumeRequired||v.review||v.importedScope)throw Error('보류 후보');
   if(old && v.baseText!==old.text)throw Error('위키 원문 충돌');
   if(old && (!publicItems({items:[old]}).length||!publicItems({items:[v]}).length))throw Error('비공개 위키 병합 금지');
   const next={...v,id:old?.id||v.id,sourceCandidateId:id};
   disclosure(old,next,c);
   if(old)s.items[s.items.indexOf(old)]=next;else if(!s.items.some(x=>x.sourceCandidateId===id))s.items.push(next);
   s.candidates=s.candidates.filter(x=>x.id!==id);
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
// Source selection for the analysis view. Message numbers are 1-based positions in
// the full chat as the host orders it (hidden messages keep their slot but are never
// listed or selectable). The input cap mirrors the service's preview check, measured
// on the time-stamped input built by sourceInput().
export const MAX_INPUT_CHARS=60000;
export const sourceNumber=(m,i)=>(Number.isSafeInteger(m?.index)&&m.index>=0?m.index:i)+1;
export function rangeStatus(range,total){
 const raw=[range?.start,range?.end],[start,end]=raw.map(x=>x===''||x===null||x===undefined?NaN:Number(x));
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<1)return {ok:false,warning:'시작·끝은 1 이상의 정수로 입력하세요.'};
 if(start>end)return {ok:false,start,end,warning:'시작 번호가 끝 번호보다 큽니다.'};
 if(!(total>0))return {ok:false,start,end,warning:'원문 목록을 읽은 뒤 범위를 확인합니다.'};
 if(start>total)return {ok:false,start,end,warning:'이 범위는 채팅 기록 밖입니다. (전체 '+total+'개)'};
 if(end>total)return {ok:true,start,end:total,warning:'끝 번호가 채팅 기록 밖이라 '+start+' - '+total+'까지만 선택합니다.'};
 return {ok:true,start,end};
}
export function rangeIds(messages,ranges,total){
 const spans=(ranges||[]).map(r=>rangeStatus(r,total)).filter(s=>s.ok);
 return messages.filter((m,i)=>{const n=sourceNumber(m,i);return spans.some(s=>n>=s.start&&n<=s.end);}).map(m=>m.id);
}
export function effectiveSelection(messages,ranges,manual,total){
 const covered=new Set(rangeIds(messages,ranges,total));
 return messages.filter(m=>covered.has(m.id)||manual?.has(m.id)).map(m=>m.id);
}
export function recentIds(messages,n){
 const count=Math.floor(Number(n));
 return Number.isSafeInteger(count)&&count>0?messages.slice(-count).map(m=>m.id):[];
}
// Analysis input: a time-zone line, then each message prefixed with its host send time
// (Lumiverse 1.2.5 Message.send_date, unix seconds; millisecond values are tolerated).
// The service builds the model input and the view measures the cap with this same
// function, so the preview check and the on-screen size never disagree.
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
export function inputSize(messages,ids,zone){
 const chosen=new Set(ids);
 return sourceInput(messages.filter(m=>chosen.has(m.id)),zone).length;
}
