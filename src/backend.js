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
 return ()=>{offMessage();offInterceptor();};
}
if(typeof spindle!=='undefined')start(spindle);
