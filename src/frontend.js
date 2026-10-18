import {createView} from './view.js';
export function setup(ctx){
 const tab=ctx.ui.registerDrawerTab({id:'cabinet',title:'기억 보관함',shortName:'기억',description:'승인 중심 기억 편집'}),root=tab.root;
 let epoch=0,serial=0,accepted=0,chatId=null,state=null,recovery=false,alive=true;
 const pending=new Map();
 const ui={tab:'overview',filter:'all',selected:new Set(),sources:new Set(),messages:[],connections:[],preview:null,status:'',editor:null,transfer:'',total:0,recentN:20,rangesByChat:{},expanded:new Set(),lastPick:null,limits:{},queries:{},queueLayer:'all',detail:null};
 const note=message=>{ui.status=message;const n=root.querySelector('[role=status]');if(n)n.textContent=message;};
 ui.note=note;
 const send=(type,extra={})=>{const requestId=crypto.randomUUID();pending.set(requestId,{epoch,type,sequence:++serial});ctx.sendToBackend({requestId,type,chatId,revision:state?.revision,...extra});};
 const view=createView(root,{send,get:()=>({chatId,state,recovery}),ui});
 const offMessage=ctx.onBackendMessage(reply=>{
  const p=pending.get(reply.requestId);pending.delete(reply.requestId);
  if(!alive||!p||p.epoch!==epoch)return;
  if(!reply.ok){note(reply.error);return;}
  if(!reply.recovery&&state&&reply.state.revision<state.revision&&!['reset','restoreBackup'].includes(p.type))return;
  if(p.sequence<accepted&&(reply.recovery||state&&reply.state?.revision===state.revision))return;
  accepted=Math.max(accepted,p.sequence);chatId=reply.chatId;state=reply.state;recovery=!!reply.recovery;
  if(reply.messages){ui.messages=reply.messages;delete ui.limits.sources;ui.total=Number.isSafeInteger(reply.total)?reply.total:reply.messages.length;ui.lastPick=null;}
  if(reply.connections)ui.connections=reply.connections;
  if(reply.preview)ui.preview=reply.preview;
  if(reply.json){ui.transfer=reply.json;ui.tab='settings';}
  if(reply.saved){ui.editor=null;if(p.type==='analyze')ui.tab='overview';}
  if(['reset','restoreBackup'].includes(p.type)){epoch++;pending.clear();ui.messages=[];ui.total=0;ui.sources.clear();ui.expanded.clear();ui.lastPick=null;ui.preview=null;ui.selected.clear();ui.editor=null;ui.limits={};ui.queries={};ui.queueLayer='all';ui.detail=null;}
  ui.status=reply.notice||(reply.saved?'저장 완료':reply.output||'불러오기 완료');
  view.render();
 });
 const offSwitch=ctx.events.on('CHAT_SWITCHED',p=>{
  epoch++;chatId=p.chatId||null;state=null;recovery=false;pending.clear();
  ui.messages=[];ui.total=0;ui.sources.clear();ui.expanded.clear();ui.lastPick=null;ui.preview=null;ui.selected.clear();ui.editor=null;ui.limits={};ui.queries={};ui.queueLayer='all';ui.detail=null;ui.transfer='';ui.status='';
  view.render();if(chatId)send('load');
 });
 view.render();send('load');
 return ()=>{alive=false;epoch++;pending.clear();offMessage();offSwitch();root.replaceChildren();tab.destroy();};
}