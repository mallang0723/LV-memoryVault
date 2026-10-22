// Insecure-origin QA: the built panel over plain http on a non-localhost host name, the way a phone reaches
// Lumiverse on a PC over Tailscale (http://100.x.y.z:7860). Such a page is not a secure context, so
// crypto.randomUUID (and crypto.subtle, navigator.clipboard ...) are missing; 0.4.3 failed here with
// "crypto.randomUUID is not a function" on every request. A file:// page (playwright-qa.js) is a secure
// context and cannot catch this. The host name memoryvault.test is mapped to the local QA server (Chromium:
// --host-resolver-rules, Firefox: network.dns.localDomains); no other network, synthetic backend.
// Checks per browser that the page really is insecure, the drawer loads, request ids are made, a two-range
// analysis batch starts, and the manual editor opens (the four places the panel makes ids).
// Playwright is not a project dependency: PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs;
// FIREFOX_BIN / CHROMIUM_BIN pick browser executables.
import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const module=process.env.PLAYWRIGHT_MODULE;
if(!module){console.error('Playwright not found (set PLAYWRIGHT_MODULE)');process.exit(2);}
const pw=await import(pathToFileURL(resolve(module)).href);
const HOST='memoryvault.test';
const V4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const harness=`
const root=document.getElementById('drawer'),sent=[];let listener;window.__sent=sent;
const state={version:1,revision:0,items:[],candidates:[],undo:[]};
const answer=r=>{const base={requestId:r.requestId,ok:true,chatId:'a',state};
 if(r.type==='connections')return {...base,connections:[{id:'conn',name:'가짜 연결',model:'fixture'}]};
 if(r.type==='count')return {...base,total:60,hidden:[]};
 if(r.type==='analyze')return {requestId:r.requestId,ok:false,error:'합성 응답: 분석하지 않음'};
 return base;};
window.__panel.setup({ui:{registerDrawerTab:()=>({root,destroy(){}}),showConfirm:async()=>({confirmed:true})},sendToBackend:r=>{sent.push(r);setTimeout(()=>listener(answer(r)),0);},onBackendMessage:fn=>{listener=fn;return()=>{};},events:{on:()=>()=>{}}});
`;
const html=()=>'<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#17151e}</style></head><body><div id="drawer"></div>'
 +'<script type="module">'+readFileSync('dist/frontend.js','utf8').replace(/<\/script/gi,'<\\/script')+'\nwindow.__panel={setup};</script><script type="module">'+harness+'</script></body></html>';
const server=createServer((req,res)=>{if(new URL(req.url,'http://x').pathname!=='/'){res.statusCode=404;return res.end('not found');}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html());});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://${HOST}:${server.address().port}/`;
const chromium=process.env.CHROMIUM_BIN||[resolve(homedir(),'.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell'),'/usr/bin/chromium'].find(existsSync);
const browsers=[
 ['chromium',()=>pw.chromium.launch({...(chromium?{executablePath:chromium}:{}),args:[`--host-resolver-rules=MAP ${HOST} 127.0.0.1`]})],
 ['firefox',()=>pw.firefox.launch({...(process.env.FIREFOX_BIN?{executablePath:process.env.FIREFOX_BIN}:{}),firefoxUserPrefs:{'network.dns.localDomains':HOST,'network.proxy.type':0}})],
];
const failures=[],rows=[];
for(const [name,launch] of browsers){
 let browser;const errors=[];
 try{
  browser=await launch();
  const p=await browser.newPage({viewport:{width:390,height:844}});
  p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await p.goto(url);await p.waitForSelector('#mmc-root-v1 .mmc-tabs',{timeout:15000});
  const context=await p.evaluate(()=>({secure:window.isSecureContext,randomUUID:typeof globalThis.crypto?.randomUUID,getRandomValues:typeof globalThis.crypto?.getRandomValues,subtle:typeof globalThis.crypto?.subtle,clipboard:typeof navigator.clipboard,origin:location.origin}));
  if(context.secure!==false||context.randomUUID!=='undefined'){failures.push(`${name}: page is not an insecure context (${JSON.stringify(context)}); the check proves nothing`);continue;}
  const button=t=>p.locator('#mmc-root-v1 button',{hasText:new RegExp('^'+t.replace(/[+]/g,'\\+')+'$')}).first();
  // Settings → connection, then a two-range analysis (a batch id plus one request id per range).
  await button('설정').click();await p.selectOption('[aria-label="모델 연결"]','conn');
  await button('분석').click();await button('범위').click();
  await p.fill('[aria-label="범위 1 시작"]','1');await p.fill('[aria-label="범위 1 끝"]','20');
  await button('+ 범위 추가').click();
  await p.locator('[data-run=analyze]').click();
  await p.waitForFunction(()=>window.__sent.some(r=>r.type==='analyze'),null,{timeout:10000});
  // Manual editor (a new item id).
  await p.locator('[data-tab=promises]').click();await button('직접 추가').click();
  const editor=await button('목록으로').isVisible({timeout:5000}).catch(()=>false);
  const sent=await p.evaluate(()=>window.__sent.map(r=>({type:r.type,requestId:r.requestId})));
  const status=await p.evaluate(()=>document.querySelector('[role=status]')?.textContent||'');
  rows.push({browser:name,context,requests:sent.map(r=>r.type),analyses:sent.filter(r=>r.type==='analyze').length,editor,status,errors});
  const bad=[...errors,status].filter(t=>/randomUUID|is not a function/i.test(t));
  if(bad.length)failures.push(`${name}: ${bad.join(' | ')}`);
  if(sent[0]?.type!=='load')failures.push(`${name}: first request is not load (${JSON.stringify(sent[0])})`);
  if(!sent.every(r=>V4.test(r.requestId)))failures.push(`${name}: request ids are not v4 (${JSON.stringify(sent.map(r=>r.requestId))})`);
  if(new Set(sent.map(r=>r.requestId)).size!==sent.length)failures.push(`${name}: duplicate request ids`);
  if(!sent.some(r=>r.type==='analyze'))failures.push(`${name}: analysis was not sent`);
  if(!editor)failures.push(`${name}: manual editor did not open`);
 }catch(e){failures.push(`${name}: ${String(e?.message||e).split('\n')[0]}${errors.length?' · page errors: '+[...new Set(errors)].join(' | '):''}`);}
 finally{await browser?.close();}
}
server.close();
console.log(JSON.stringify(rows,null,1));
if(failures.length){console.error('FAIL\n'+failures.join('\n'));process.exit(1);}
console.log(`insecure-origin QA passed (${rows.map(r=>r.browser+' '+r.context.origin).join(', ')})`);
