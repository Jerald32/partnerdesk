import type {Services} from './handler.ts';
export function authenticateOnce(service:Services):Services{
 const verified=new Map<string,ReturnType<Services['authenticate']>>();
 return {...service,authenticate(jwt:string){
  if(!verified.has(jwt))verified.set(jwt,service.authenticate(jwt));
  return verified.get(jwt)!;
 }};
}
export function timedServices(service:Services){
 const start=performance.now(),durations=new Map<string,number>();let authChecks=0;
 const measure=async<T>(name:string,fn:()=>Promise<T>)=>{const began=performance.now();try{return await fn();}finally{durations.set(name,(durations.get(name)||0)+performance.now()-began);}};
 return {service:{...service,
  authenticate:(jwt:string)=>{authChecks++;return measure('e_auth',()=>service.authenticate(jwt));},
  profile:(id:string)=>measure('e_profile',()=>service.profile(id)),
  ipPolicy:()=>measure('e_policy',()=>service.ipPolicy()),
  rpc:((name,args)=>measure(name==='backend_gateway_consume'?'e_proof_db':'e_session_db',()=>service.rpc(name,args))) as Services['rpc'],
 },finish(result:Response){
  const headers=new Headers(result.headers);
  headers.set('Server-Timing',[...durations].map(([name,ms])=>`${name};dur=${ms.toFixed(1)}`).concat(`e_total;dur=${(performance.now()-start).toFixed(1)}`).join(', '));
  headers.set('X-PartnerDesk-Edge-Auth-Checks',String(authChecks));
  return new Response(result.body,{status:result.status,headers});
 }};
}
