// Phone-size (360×460) check of the result/error notice in real browsers through
// Playwright: Chromium and Firefox. Optional: runs only when PLAYWRIGHT_MODULE points
// at a Playwright index.mjs (FIREFOX_BIN / CHROMIUM_BIN may name the executables).
// Built panel (dist/frontend.js) + synthetic backend: eight ranges fail with a long
// error, then the notice must be one line, not cover the tab bar, expand into a
// scrolling box, fold on an outside tap, close with ×, and leave the panel usable.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const ERROR='원문 크기 초과: 대화 1–30 (30개, 숨김 30개 포함) 입력 72,961자 / 한도 60,000자. 이 범위를 더 작은 범위 여러 개로 나눠서 분석하세요.';
const harness=`
const root=document.getElementById('drawer'),sent=[];let listener;window.__sent=sent;
const state={version:1,revision:0,items:[],candidates:[],undo:[]};
const answer=r=>{const base={requestId:r.requestId,ok:true,chatId:'a',state};
 if(r.type==='connections')return {...base,connections:[{id:'conn',name:'가짜 연결',model:'fixture'}]};
 if(r.type==='count')return {...base,total:233,hidden:Array.from({length:233},(_,i)=>i+1)};
 if(r.type==='analyze')return {requestId:r.requestId,ok:false,error:${JSON.stringify(ERROR)}};
 return base;};
window.__panel.setup({ui:{registerDrawerTab:()=>({root,destroy(){}}),showConfirm:async()=>({confirmed:true})},sendToBackend:r=>{sent.push(r);setTimeout(()=>listener(answer(r)),0);},onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
`;
function page(){
 const panel=readFileSync('dist/frontend.js','utf8');
 return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#17151e}</style></head><body><div id="drawer"></div>'
  +'<script type="module">'+panel.replace(/<\/script/gi,'<\\/script')+'\nwindow.__panel={setup};</script><script type="module">'+harness+'</script></body></html>';
}
const overlap=(a,b)=>!!a&&!!b&&a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;
async function check(pw,name,launch,file,receipts){
 const out={browser:name,executable:launch.executablePath||'(Playwright default)',failures:[]};const fail=m=>out.failures.push(m);let browser;
 try{
  browser=await pw[name].launch(launch);
  const p=await browser.newPage({viewport:{width:360,height:460}});
  await p.goto(pathToFileURL(file).href);await p.waitForSelector('#mmc-root-v1 .mmc-tabs');
  const button=t=>p.locator('#mmc-root-v1 button',{hasText:new RegExp('^'+t.replace(/[+]/g,'\\+')+'$')}).first();
  await button('설정').click();await p.selectOption('[aria-label="모델 연결"]','conn');
  await button('분석').click();await button('범위').click();
  await p.fill('[aria-label="범위 1 시작"]','1');await p.fill('[aria-label="범위 1 끝"]','30');
  for(let i=0;i<7;i++)await button('+ 범위 추가').click();
  await p.locator('[data-run=analyze]').click();
  await p.waitForFunction(()=>/모두 실패/.test(document.querySelector('[role=status]')?.textContent||''),null,{timeout:10000});
  out.summary=await p.textContent('[role=status]');
  if(out.summary!=='8개 범위 모두 실패 — 원문 크기 초과')fail('summary '+out.summary);
  const box=async s=>p.locator(s).first().boundingBox();
  // Scrolled to the top: the tab bar is on screen and the notice must not cover it.
  await p.evaluate(()=>window.scrollTo(0,0));
  out.collapsed={bar:await box('.lv-status'),tabs:await box('.mmc-tabs')};
  if(!(out.collapsed.bar?.height<=70))fail('collapsed notice too tall '+JSON.stringify(out.collapsed.bar));
  if(overlap(out.collapsed.bar,out.collapsed.tabs))fail('collapsed notice covers the tabs');
  await p.locator('[data-status-more]').click();
  out.expanded={bar:await box('.lv-status'),tabs:await box('.mmc-tabs'),scroll:await p.evaluate(()=>{const d=document.querySelector('[data-status-detail]');return d?{scrollHeight:d.scrollHeight,clientHeight:d.clientHeight,overflow:getComputedStyle(d).overflowY}:null;})};
  if(!out.expanded.scroll)fail('details did not open');
  if(!(out.expanded.bar?.height<=460*0.4+1))fail('expanded notice taller than 40% '+JSON.stringify(out.expanded.bar));
  if(overlap(out.expanded.bar,out.expanded.tabs))fail('expanded notice covers the tabs');
  if(out.expanded.scroll&&!(out.expanded.scroll.scrollHeight>out.expanded.scroll.clientHeight&&['auto','scroll'].includes(out.expanded.scroll.overflow)))fail('long details do not scroll '+JSON.stringify(out.expanded.scroll));
  await p.screenshot({path:resolve(receipts,'notice-'+name+'-360x460.png')});
  // Tap outside folds the details.
  await p.locator('.mmc-body').click({position:{x:10,y:10}});
  if(await p.locator('[data-status-detail]').count())fail('outside tap did not fold the details');
  // × closes, then the tab bar works.
  await p.locator('[data-status-close]').click();
  if(await p.locator('.lv-status').isVisible())fail('× did not close the notice');
  await p.locator('[data-tab=promises]').click();
  out.afterClose=await p.getAttribute('[data-tab=promises]','aria-current');
  if(out.afterClose!=='page')fail('panel not usable after closing (tab did not switch)');
 }catch(error){fail(String(error?.message||error).slice(0,400));}
 finally{await browser?.close();}
 return out;
}
export async function playwrightQa({receipts='context/receipts'}={}){
 const module=process.env.PLAYWRIGHT_MODULE;
 if(!module)return {skipped:true,exitCode:0,reason:'PLAYWRIGHT_MODULE not set'};
 mkdirSync(receipts,{recursive:true});
 const file=resolve(receipts,'notice-360.html');writeFileSync(file,page());
 const pw=await import(pathToFileURL(resolve(module)).href);
 const results=[];
 // The Playwright build may not match the browsers installed; fall back to the cached
 // headless shell or the system Chromium when no CHROMIUM_BIN is given.
 const chromium=process.env.CHROMIUM_BIN||[resolve(homedir(),'.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell'),'/usr/bin/chromium'].find(existsSync);
 results.push(await check(pw,'chromium',chromium?{executablePath:chromium}:{},file,receipts));
 results.push(await check(pw,'firefox',process.env.FIREFOX_BIN?{executablePath:process.env.FIREFOX_BIN}:{},file,receipts));
 writeFileSync(resolve(receipts,'playwright-qa.json'),JSON.stringify({viewport:'360x460',results},null,2));
 const failures=results.flatMap(r=>r.failures.map(f=>r.browser+': '+f));
 return {exitCode:failures.length?1:0,failures,browsers:results.map(r=>r.browser)};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){const r=await playwrightQa();console.log(JSON.stringify(r));process.exitCode=r.exitCode;}
