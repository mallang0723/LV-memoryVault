import {appendFileSync} from 'node:fs';
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
 if(req.method!=='POST')return Response.json({data:[{id:'fixture',object:'model'}]});
 const body=await req.json();appendFileSync(process.env.CAPTURE,JSON.stringify({...body,_qaEndpoint:req.url})+'\n');
 const content=body.messages?.some(m=>m.role==='system'&&m.content?.includes('JSON array of memory candidates'))?'[]':'Local fixture response';
 if(body.stream)return new Response('data: '+JSON.stringify({id:'fake',object:'chat.completion.chunk',choices:[{index:0,delta:{content},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fake',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 return Response.json({id:'fake',choices:[{message:{role:'assistant',content},finish_reason:'stop'}]});
}});
console.log(server.port);
