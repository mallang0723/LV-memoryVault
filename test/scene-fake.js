// Synthetic Lumiverse 1.2.5-shaped host for scene chronicle tests: user storage, chats
// with whole-replace metadata updates, messages with hidden flags, world books and
// entries with paging, and a recording model. No network, no real host.
const copy=x=>x===undefined?undefined:structuredClone(x);
export const SCENE_REPLY={title:'창고 거래',body:'[이야기 3일차 밤] 민수가 창고에서 지아에게 파란 공책을 넘기고 열쇠를 받았다.',keywords:['민수','창고','파란 공책'],promises:['[이야기 3일차 밤] 민수가 다음 날 아침까지 열쇠를 돌려주기로 했다.'],flows:[]};
export const MERGE_REPLY={title:'창고 사건',body:'[이야기 3일차 밤] 민수와 지아가 창고에서 공책과 열쇠를 맞바꾼 뒤 함께 도망쳤다.',keywords:['민수','지아','창고']};
export const makeMessages=(n,prefix='m')=>Array.from({length:n},(_,i)=>({id:prefix+(i+1),content:'원문 메시지 '+(i+1)+' 내용',is_user:i%2===0,send_date:1760000000+i*60,extra:{}}));
export function sceneFake({messages=makeMessages(60),otherBooks=0}={}){
 const db=new Map(),books=new Map(),entries=new Map(),grants=new Set(['chats','chat_mutation','generation','world_books','interceptor']);
 let seq=0;const calls={generate:[],bookCreate:[],chatUpdates:[],hidden:[],entryCreate:[],entryUpdate:[],entryDelete:[],bookDelete:[],list:0};
 const msgs={a:messages},meta={a:{loom_summary:'루미버스 요약 원문',wi_state:{keep:{active:true}},chat_variables:{mood:'calm'}}};
 const names={a:'채팅이름표본'};
 for(let i=0;i<otherBooks;i++){const id='other-'+i;books.set(id,{id,name:'다른 책 '+i,description:'',metadata:{},created_at:i,updated_at:i});}
 let reply=input=>JSON.stringify(input.messages[0].content.includes('하나의 기록으로 합친다')?MERGE_REPLY:SCENE_REPLY);
 const hooks={beforeBookCreate:null,afterBookCreate:null};
 const api={
  permissions:{has:p=>grants.has(p)},
  chats:{
   getActive:async()=>({id:'a'}),
   get:async(id,u)=>u==='owner'&&meta[id]?{id,name:names[id]||'',created_at:1,metadata:copy(meta[id])}:null,
   update:async(id,input,u)=>{if(u!=='owner'||!meta[id])throw Error('Chat not found');calls.chatUpdates.push({id,input:copy(input)});if(input.metadata!==undefined)meta[id]=copy(input.metadata);return {id,metadata:copy(meta[id])};}
  },
  chat:{
   getMessages:async id=>copy(msgs[id]||[]),
   setMessagesHidden:async(id,ids,hidden)=>{calls.hidden.push({id,ids:[...ids],hidden});for(const m of msgs[id]||[])if(ids.includes(m.id))m.extra={...m.extra,hidden};}
  },
  userStorage:{exists:async k=>db.has(k),getJson:async k=>copy(db.get(k)),setJson:async(k,v)=>{db.set(k,copy(v));}},
  connections:{get:async id=>({id,name:'가짜 연결',provider:'fixture',model:'fixture-model'})},
  generate:{raw:async input=>{calls.generate.push(copy(input));return {content:reply(input)};},quiet:async input=>{calls.generate.push(copy(input));return {content:reply(input)};}},
  world_books:{
   list:async({limit=50,offset=0}={})=>{calls.list++;const all=[...books.values()];return {data:all.slice(offset,offset+Math.min(limit,200)).map(copy),total:all.length};},
   get:async id=>books.has(id)?copy(books.get(id)):null,
   create:async input=>{await hooks.beforeBookCreate?.();await new Promise(r=>setTimeout(r,2));const b={id:'book-'+(++seq),name:input.name,description:input.description||'',metadata:copy(input.metadata||{}),created_at:1000+seq,updated_at:1000+seq};books.set(b.id,b);calls.bookCreate.push(copy(b));await hooks.afterBookCreate?.(b);return copy(b);},
   update:async(id,input)=>{const b=books.get(id);Object.assign(b,copy(input));return copy(b);},
   delete:async id=>{calls.bookDelete.push(id);for(const [k,e] of entries)if(e.world_book_id===id)entries.delete(k);return books.delete(id);},
   entries:{
    list:async(bookId,{limit=50,offset=0}={})=>{const all=[...entries.values()].filter(e=>e.world_book_id===bookId);return {data:all.slice(offset,offset+Math.min(limit,200)).map(copy),total:all.length};},
    get:async id=>entries.has(id)?copy(entries.get(id)):null,
    create:async(bookId,input)=>{if(!books.has(bookId))throw Error('World book not found');const e={id:'entry-'+(++seq),world_book_id:bookId,key:[],keysecondary:[],content:'',comment:'',position:0,depth:4,order_value:100,constant:false,disabled:false,scan_depth:null,match_whole_words:false,extensions:{},...copy(input)};entries.set(e.id,e);calls.entryCreate.push({bookId,input:copy(input)});return copy(e);},
    update:async(id,input)=>{const e=entries.get(id);if(!e)throw Error('World book entry not found');Object.assign(e,copy(input));calls.entryUpdate.push({id,bookId:e.world_book_id,input:copy(input)});return copy(e);},
    delete:async id=>{const e=entries.get(id);calls.entryDelete.push({id,bookId:e?.world_book_id});return entries.delete(id);}
   }
  }
 };
 return {api,db,books,entries,grants,calls,msgs,meta,names,hooks,setReply:fn=>{reply=fn;}};
}
// Runs a request as the authenticated owner of chat 'a' (or the given chat).
export const as=(s,r)=>s.run({chatId:'a',...r},'owner');
export const rec=(s,start,end,extra={})=>as(s,{type:'sceneRecord',mode:'raw',connection:'conn',timeZone:'Asia/Seoul',source:{scope:'range',ranges:[{start:String(start),end:String(end)}]},...extra});
// Load, then approve the newest candidate with the given scope.
export async function approveLast(s,scope='public',chatId='a'){
 const v=(await s.run({type:'sceneLoad',chatId},'owner')).chronicle;
 const c=v.candidates.at(-1);
 return s.run({type:'sceneApprove',chatId,id:c.id,scope,...(scope==='public'?{confirmPublic:true}:{}),sceneRevision:v.revision},'owner');
}
