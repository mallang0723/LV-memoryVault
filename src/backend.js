import {createService} from './service.js';
export function start(api){
 const service=createService(api);
 const offInterceptor=api.registerInterceptor((messages,context)=>service.intercept(messages,context),{required:false});
 const offMessage=api.onFrontendMessage(async(payload,userId,frontendSessionId)=>{
  if(typeof userId!=='string'||!userId)return;
  if(!payload||typeof payload.requestId!=='string')return;
  let reply;try{reply={ok:true,...await service.run(payload,userId)};}catch(error){reply={ok:false,error:error.message};}
  api.sendToFrontend({...reply,requestId:payload.requestId},userId,frontendSessionId?{frontendSessionId}:undefined);
 });
 // Automatic analysis (off unless the user enabled it for a chat). Lumiverse 1.2.5
 // delivers host events as handler(payload, userId); the check runs after the reply.
 const offEnded=typeof api.on==='function'?api.on('GENERATION_ENDED',(payload,userId)=>{service.onGenerationEnded(payload,userId).catch(()=>{});service.onSceneEvent(payload,userId).catch(()=>{});}):()=>{};
 // Scene chronicle: edits, swipes and deletions can make a recorded scene stale; the
 // world-info interceptor turns such entries (and a parent chat's book copied into a
 // branch) off for the prompt being assembled even before that re-check has run.
 const offScene=typeof api.on==='function'?['MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED'].map(e=>api.on(e,(payload,userId)=>{service.onSceneEvent(payload,userId).catch(()=>{});})):[];
 if(typeof api.registerWorldInfoInterceptor==='function'&&api.permissions?.has?.('generation')){try{api.registerWorldInfoInterceptor(ctx=>service.worldInfoGuard(ctx),100);}catch{}}
 return ()=>{offEnded();for(const off of offScene)if(typeof off==='function')off();service.stop();offMessage();offInterceptor();};
}
if(typeof spindle!=='undefined')start(spindle);
