import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createService} from '../src/service.js';
import {classifyCheck} from './run-check.js';
import {browserQa} from './browser-qa.js';
import {playwrightQa} from './playwright-qa.js';
const receipts='context/receipts';mkdirSync(receipts,{recursive:true});
const results=[];
for(const [name,args] of [['tests',['--test','--test-isolation=none',...readdirSync('test').filter(x=>x.endsWith('.test.js')).sort().map(x=>'test/'+x)]],['build',['scripts/build.js']],['backend-syntax',['--check','dist/backend.js']],['frontend-syntax',['--check','dist/frontend.js']]]){
 const r=spawnSync(process.execPath,args,{encoding:'utf8'});writeFileSync(receipts+'/'+name+'.txt',(r.stdout||'')+(r.stderr||'')+(r.error?.message||''));results.push({name,command:[process.execPath,...args],...classifyCheck(r,name==='tests')});
}
// Synthetic, in-process API adapter only. No provider socket, host data or credentials.
const db=new Map();let providerRequest;
const api={permissions:{has:()=>true},chats:{getActive:async()=>({id:'synthetic'}),get:async()=>({id:'synthetic',metadata:{}})},userStorage:{exists:async k=>db.has(k),getJson:async k=>db.get(k),setJson:async(k,v)=>db.set(k,v)},chat:{getMessages:async()=>[{id:'source',content:'Alice promised to return the blue notebook.',extra:{}}]},connections:{get:async id=>({id,name:'fake-local',provider:'fake',model:'fake-model'})},generate:{raw:async input=>{providerRequest=input;return {content:'[{"layer":"promises","text":"Return the blue notebook","scope":"public"}]'};}}};
const service=createService(api);
const analyzed=await service.run({type:'analyze',chatId:'synthetic',revision:0,mode:'raw',connection:'fake-local',source:{scope:'last',n:20}},'synthetic-user');
writeFileSync(receipts+'/fake-provider-request.json',JSON.stringify({kind:'in-process fake adapter (not actual host/provider integration)',request:providerRequest,candidateCount:analyzed.state.candidates.length,approvedCount:analyzed.state.items.length},null,2));
const output=readFileSync('dist/backend.js','utf8');
const forbidden=['process.env','Bun.file','Bun.serve','fetch(','cortex','council','getMemories','node:fs','node:child_process'];
const matches=forbidden.filter(x=>output.includes(x));
results.push({name:'limited-static-policy-check (not host scanner)',exitCode:matches.length?1:0,matches});
// Headless Chromium at 390px over the built panel with a synthetic backend (skipped,
// not failed, when no Chromium is installed).
const browser=browserQa({receipts});
// Notice at 360×460 in Chromium and Firefox via Playwright (only when PLAYWRIGHT_MODULE is set).
const pwr=await playwrightQa({receipts});
results.push({name:'notice-360x460 (Playwright Chromium+Firefox)',exitCode:pwr.exitCode,...(pwr.skipped?{skipped:pwr.reason}:{failures:pwr.failures})});
results.push({name:'browser-390 (headless Chromium, synthetic backend)',exitCode:browser.exitCode,...(browser.skipped?{skipped:browser.reason}:{failures:browser.failures})});
writeFileSync(receipts+'/results.json',JSON.stringify({time:new Date().toISOString(),results,stockHostIntegration:'NOT RUN',browserLayout:browser.skipped?'NOT RUN; DOM structure only ('+browser.reason+')':'headless Chromium 390px, synthetic backend (scene panel)',fakeModelOnly:true},null,2));
console.log(JSON.stringify(results));process.exitCode=results.some(r=>r.exitCode!==0)?1:0;
