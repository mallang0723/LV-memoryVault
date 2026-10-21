// Phone-width browser check of the built panel (dist/frontend.js) in headless
// Chromium at 390px: the 장면록 one-tap record flow with a synthetic backend, no
// horizontal overflow, touch-size buttons, and request payloads without message text.
// Returns {exitCode:0|1,...} or {skipped:true} when no Chromium is installed.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const harness=`
const root=document.getElementById('drawer'),sent=[];let listener;
const state={version:1,revision:0,items:[],candidates:[],undo:[]};
const node=(id,a,b,mode)=>({id,kind:'scene',label:'장면 '+a+'–'+b,title:'창고에서의 거래',body:'[이야기 3일차 밤] 민수가 창고에서 지아에게 파란 공책을 넘기고 열쇠를 받았다. 둘은 새벽까지 기다리기로 했다.',keywords:['민수','창고'],scope:'public',start:a,end:b,count:b-a+1,revision:1,tokens:60,state:'approved',reason:'',mode,parentId:'',children:[],entry:true,entryEdited:false});
const chron=(rev,extra)=>Object.assign({revision:rev,nodes:[node('n1',1,20,'keyword'),node('n2',21,40,'constant')],candidates:[],settings:{inject:true,budget:2000,keywords:true,scanDepth:6,autoHide:false,protectRecent:10,maxBody:600,mergeBody:900,constantChapters:1,constantScenes:3},book:{name:'기억 보관함 장면록 · a1b2c3',attached:true},constantTokens:60,permission:true,lumibooks:false,branch:false,hidden:0,next:{start:'41',end:'60'},total:60},extra||{});
const answer=r=>{const base={requestId:r.requestId,ok:true,chatId:'a',state};
 if(r.type==='connections')return {...base,connections:[{id:'conn',name:'가짜 연결',model:'fixture'}]};
 if(r.type==='count')return {...base,total:60,hidden:[3,4]};
 if(r.type==='sceneLoad')return {...base,chronicle:chron(3)};
 if(r.type==='sceneRecord')return {...base,chronicle:chron(4,{candidates:[{...node('c1',41,60,'none'),replaces:''}],next:null}),notice:'대화 41–60 장면 기록 · 검토 대기에 장면 후보 1개'};
 return base;};
const {setup}=window.__panel;
setup({ui:{registerDrawerTab:()=>({root,destroy(){}}),showConfirm:async()=>({confirmed:true})},sendToBackend:r=>{sent.push(r);setTimeout(()=>listener(answer(r)),0);},onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
const tick=()=>new Promise(r=>setTimeout(r,20));
const click=t=>{const b=[...root.querySelectorAll('button')].find(x=>x.textContent===t);if(!b)throw Error('no button '+t);b.click();};
(async()=>{const out={};try{
 await tick();click('설정');await tick();
 const sel=root.querySelector('[aria-label="모델 연결"]');sel.value='conn';sel.onchange();
 root.querySelector('[data-tab=scenes]').click();await tick();await tick();
 const run=root.querySelector('[data-run=scene]');
 out.prefill=[root.querySelector('[aria-label="구간 1 시작"]').value,root.querySelector('[aria-label="구간 1 끝"]').value];
 out.summary=root.querySelector('[data-scene-summary]').textContent;
 out.recordButton={w:run.getBoundingClientRect().width,h:run.getBoundingClientRect().height,disabled:run.disabled};
 out.smallButtons=[...root.querySelectorAll('.lv-actions .mmc-btn,.lv-bulk .mmc-btn,.lv-run,.lv-add')].filter(b=>b.getBoundingClientRect().height>0&&b.getBoundingClientRect().height<44).map(b=>b.textContent);
 out.overflow={doc:document.documentElement.scrollWidth,viewport:window.innerWidth,wide:[...root.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>window.innerWidth+1).map(e=>e.tagName+'.'+e.className).slice(0,5)};
 run.click();await tick();await tick();
 out.requests=sent.map(r=>r.type);
 out.record=sent.filter(r=>r.type==='sceneRecord');
 out.payloadHasMessageText=JSON.stringify(sent).includes('원문 메시지');
 out.status=root.querySelector('[role=status]').textContent;
 out.queue=!!root.querySelector('[data-scene-candidate=c1]');
}catch(e){out.error=String(e&&e.stack||e);}
parent.postMessage(JSON.stringify(out),'*');})();
`;
export function browserQa({receipts='context/receipts'}={}){
 const chrome=['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'].find(existsSync);
 if(!chrome)return {skipped:true,exitCode:0,reason:'Chromium not found'};
 mkdirSync(receipts,{recursive:true});
 const panel=readFileSync('dist/frontend.js','utf8');
 // Headless Chromium will not open a window narrower than 500px, so the panel runs in
 // a 390px-wide frame (its own viewport) and reports back with postMessage.
 const inner='<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#17151e}</style></head><body><div id="drawer"></div>'
  +'<script type="module">'+panel.replace(/<\/script/gi,'<\\/script')+'\nwindow.__panel={setup};</script><script type="module">'+harness+'</script></body></html>';
 writeFileSync(resolve(receipts,'scene-panel-inner.html'),inner);
 const html='<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}iframe{border:0;display:block}</style></head><body><iframe src="scene-panel-inner.html" width="390" height="1600"></iframe><pre id="result"></pre><script>addEventListener("message",e=>{document.getElementById("result").textContent=e.data;});</script></body></html>';
 const page=resolve(receipts,'scene-panel-390.html');writeFileSync(page,html);
 const profile=mkdtempSync(join(tmpdir(),'mv-qa-'));
 try{
  const args=['--headless=new','--disable-gpu','--no-first-run','--user-data-dir='+profile,'--window-size=500,1600','--allow-file-access-from-files','--virtual-time-budget=5000'];
  const dom=spawnSync(chrome,[...args,'--dump-dom',pathToFileURL(page).href],{encoding:'utf8',timeout:60000});
  spawnSync(chrome,[...args,'--screenshot='+resolve(receipts,'scene-panel-390.png'),pathToFileURL(page).href],{encoding:'utf8',timeout:60000});
  const m=(dom.stdout||'').match(/<pre id="result">([\s\S]*?)<\/pre>/);
  if(!m||!m[1])return {exitCode:1,error:'no result',stderr:(dom.stderr||'').slice(-400)};
  const r=JSON.parse(m[1].replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'));
  const failures=[];
  if(r.error)failures.push(r.error);
  if(JSON.stringify(r.prefill)!=='["41","60"]')failures.push('prefill '+JSON.stringify(r.prefill));
  if(!(r.recordButton?.h>=44)||r.recordButton?.disabled)failures.push('record button '+JSON.stringify(r.recordButton));
  if(r.smallButtons?.length)failures.push('buttons under 44px: '+r.smallButtons.join(', '));
  if(!(r.overflow?.doc<=r.overflow?.viewport)||r.overflow?.wide?.length)failures.push('horizontal overflow '+JSON.stringify(r.overflow));
  if(r.record?.length!==1||JSON.stringify(r.record[0].source)!=='{"scope":"range","ranges":[{"start":"41","end":"60"}]}')failures.push('record request '+JSON.stringify(r.record));
  if(r.payloadHasMessageText)failures.push('message text in a panel request');
  if(!r.queue)failures.push('candidate not shown after one tap');
  writeFileSync(resolve(receipts,'browser-qa.json'),JSON.stringify({browser:chrome,width:390,result:r,failures},null,2));
  return {exitCode:failures.length?1:0,failures,width:390};
 }finally{rmSync(profile,{recursive:true,force:true});}
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){const r=browserQa();console.log(JSON.stringify(r));process.exitCode=r.exitCode;}
