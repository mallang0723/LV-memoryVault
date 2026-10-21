import {createView} from './view.js';
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
 const view=createView(root,{send,get:()=>({chatId,state,recovery,epoch}),ui,confirm});
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