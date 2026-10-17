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
