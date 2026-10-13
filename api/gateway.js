import {randomUUID} from 'node:crypto';
import {platformIP,evaluateIP,signProof} from '../server/gateway/security.mjs';
import {readQuery,projection,RPCS} from '../server/gateway/transport.mjs';
import {requestTiming} from '../server/gateway/timing.mjs';
let firstRequest=true;

function send(res,status,body,headers={}){
 res.statusCode=status;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
 for(const [key,value]of Object.entries(headers))res.setHeader(key,value);
 res.end(typeof body==='string'?body:JSON.stringify(body));
}
export default async function handler(req,res){
 const timing=requestTiming({first:firstRequest});firstRequest=false;
 let operation='unclassified',transport='unclassified',pageStats=null;
 const reply=(status,body,headers={})=>{
  if(process.env.VERCEL_ENV==='preview')console.info(JSON.stringify({event:'gateway_performance',operation,transport,status,...timing.record(),...(pageStats?{client_observed_pages:pageStats}:{})}));
  return send(res,status,body,{...timing.headers(),...headers});
 };
 const requestId=randomUUID();
 try{
  const base=process.env.PARTNERDESK_SUPABASE_URL,publishable=process.env.PARTNERDESK_SUPABASE_PUBLISHABLE_KEY;
  const service=process.env.PARTNERDESK_SUPABASE_SERVICE_KEY,key=process.env.PARTNERDESK_GATEWAY_SIGNING_KEY;
  if(!base||!publishable||!service||!key)throw new Error('not_configured');
  const upstream=new URL(base);if(upstream.protocol!=='https:'||upstream.hostname!=='bqtlopwgjvvugalktldr.supabase.co')throw new Error('invalid_backend');
  const url=new URL(req.url,'https://partnerdesk-phi.vercel.app');
  const route=url.pathname.startsWith('/api/gateway/')?url.pathname.slice('/api/gateway/'.length):url.searchParams.get('gateway_path');
  if(typeof route!=='string')throw new Error('route_not_allowed');
  url.searchParams.delete('gateway_path');
  let read=null,rpc=null,isEdge=route==='functions/v1/app-auth';
  if(route.startsWith('rest/v1/rpc/')&&req.method==='POST'){
   rpc=route.slice('rest/v1/rpc/'.length);if(!RPCS.has(rpc)||url.search)throw new Error('route_not_allowed');
  }else if(route.startsWith('rest/v1/')&&req.method==='GET')read=readQuery(route.slice('rest/v1/'.length),url.searchParams);
  else if(!isEdge||req.method!=='POST'||url.search)throw new Error('route_not_allowed');
  const publicRpc=rpc==='list_signup_consent_policies';
  const authorization=req.headers.authorization;
  let userId=null;
  const call=async(path,body,privileged=false,extra={})=>fetch(new URL(path,base),{method:'POST',headers:{apikey:privileged?service:publishable,
   ...(privileged?{Authorization:'Bearer '+service}:userId?{Authorization:authorization}:{}),'Content-Type':'application/json',...extra},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  let policyResponse;
  if(!publicRpc){
   if(typeof authorization!=='string'||!/^Bearer [^\s]+$/i.test(authorization))return reply(401,{message:'authentication_required'});
   const [authResult,policyResult]=await Promise.allSettled([
    timing.measure('auth',()=>fetch(new URL('/auth/v1/user',base),{headers:{apikey:publishable,Authorization:authorization},signal:AbortSignal.timeout(10000)})),
    timing.measure('policy',()=>call('/rest/v1/rpc/backend_gateway_policy',{},true)),
   ]);
   if(authResult.status==='rejected')throw authResult.reason;
   const auth=authResult.value;
   if(!auth.ok)return reply(401,{message:'invalid_jwt'});
   const user=await auth.json();if(typeof user.id!=='string')throw new Error('invalid_identity');userId=user.id;
   if(policyResult.status==='rejected')throw policyResult.reason;
   policyResponse=policyResult.value;
  }
  else policyResponse=await timing.measure('policy',()=>call('/rest/v1/rpc/backend_gateway_policy',{},true));
  if(!policyResponse.ok)throw new Error('policy_unavailable');
  const policy=await policyResponse.json(),ip=platformIP(req.headers),verdict=evaluateIP(ip,policy);
  if(verdict.wouldDeny){
   const audit=await timing.measure('audit',()=>call('/rest/v1/rpc/backend_gateway_audit',{p_user:userId,p_ip:ip,p_path:route,
    p_verdict:verdict.allowed?'monitor_would_deny':'ip_denied',p_request_id:requestId},true));
   if(!audit.ok)throw new Error('audit_unavailable');
  }
  if(!verdict.allowed)return reply(403,{message:'ip_not_allowed',request_id:requestId});
  const sessionToken=req.headers['x-partnerdesk-session']||null;
  let body,action=null;
  if(read)body=JSON.stringify(read.request);
  else{
   const input=typeof req.body==='string'?JSON.parse(req.body):req.body;
   if(!input||typeof input!=='object'||Array.isArray(input)||JSON.stringify(input).length>65536)throw new Error('invalid_body');
   body=isEdge?JSON.stringify(input):JSON.stringify({name:rpc,args:input});
   if(isEdge&&['validate-session','activate-without-mfa','send-code','verify-code','logout'].includes(input.action))action=input.action;
   if(isEdge&&action==='validate-session'&&Object.keys(input).length!==1)throw new Error('invalid_body');
  }
  const baseline=process.env.VERCEL_ENV==='preview'&&req.headers['x-partnerdesk-performance-baseline']==='1';
  // Enable only after this environment's DB migration and Preview acceptance.
  // Default remains the existing Edge path; never mutate a shared DB for Preview.
  const validationInDB=isEdge&&action==='validate-session'&&!baseline&&process.env.PARTNERDESK_SESSION_VALIDATION_DB==='true';
  if(validationInDB)body=JSON.stringify({name:'validate_app_session',args:{}});
  const viaEdge=isEdge&&!validationInDB;
  operation=isEdge?'app-auth/'+(action||'unsupported'):read?'read/'+read.request.table:'rpc/'+rpc;
  transport=viaEdge?'edge':validationInDB?'session-db':'data-db';
  if(process.env.VERCEL_ENV==='preview'){
   try{const value=JSON.parse(req.headers['x-partnerdesk-performance-pages']||'null');
    if(Array.isArray(value)&&value.length<=2&&value.every(x=>['ticket_list','ticket_detail'].includes(x.page)&&Number.isFinite(x.ms)&&x.ms>=0&&x.ms<120000&&Number.isInteger(x.requests)&&x.requests>=0&&x.requests<200))pageStats=value.map(({page,ms,requests})=>({page,ms,requests}));
   }catch{ /* Diagnostic input is never an authorization or audit fact. */ }
  }
  const path=viaEdge?'functions/app-auth':read?'rpc/gateway_read':'rpc/gateway_rpc';
  const proof=await timing.measure('proof',()=>signProof({ip,userId,sessionToken,path,method:'POST',body,policyVersion:policy.version},key,{requestId}));
  const headers={'X-PartnerDesk-Proof':proof.payload,'X-PartnerDesk-Signature':proof.signature};
  if(sessionToken)headers['X-PartnerDesk-Session']=sessionToken;
  if(viaEdge)headers.Origin='https://partnerdesk-phi.vercel.app';
  const candidate=process.env.PARTNERDESK_APP_AUTH_FUNCTION;
  const edgeFunction=baseline?'app-auth-perf-preview':process.env.VERCEL_ENV==='preview'&&['app-auth-perf-preview','app-auth-perf-candidate'].includes(candidate)?candidate:'app-auth';
  const target=viaEdge?'/functions/v1/'+edgeFunction:'/rest/v1/'+path;
  const result=await timing.measure('upstream',()=>viaEdge?fetch(new URL(target,base),{method:'POST',headers:{apikey:publishable,Authorization:authorization,'Content-Type':'application/json','x-region':'ap-northeast-2',...headers},body,signal:AbortSignal.timeout(20000)}):call(target,{p_request:body},false,headers));
  if(viaEdge)timing.edge(result);
  if(!result.ok){const failure=await result.json().catch(()=>({}));
   return reply(result.status,{message:typeof failure.message==='string'?failure.message:'backend_rejected',code:failure.code,success:false,reason:failure.reason});
  }
  const data=await timing.measure('response',()=>result.json());
  if(data?._gateway_error)return reply(data._gateway_error.code==='42501'?403:400,data._gateway_error);
  if(validationInDB&&data.success!==true){
   const reason=data.reason,unauthorized=['session_not_found','session_revoked','absolute_expired','idle_expired'].includes(reason);
   return reply(unauthorized?401:reason==='invalid_session_token'?400:403,{success:false,reason});
  }
  if(!read)return reply(200,data);
  if(!Array.isArray(data.rows)||!Number.isSafeInteger(data.count))throw new Error('invalid_response');
  const rows=data.rows.map(row=>projection(row,read.fields));
  const responseHeaders={'Content-Range':rows.length?`${read.request.offset}-${read.request.offset+rows.length-1}/${data.count}`:`*/${data.count}`};
  if(req.headers.accept?.includes('application/vnd.pgrst.object+json')){
   if(rows.length!==1)return reply(406,{code:'PGRST116',message:'Expected one row'},responseHeaders);
   return reply(200,rows[0],responseHeaders);
  }
  return reply(200,rows,responseHeaders);
 }catch(error){
  const inputError=['route_not_allowed','invalid_table','invalid_select','unsupported_filter','invalid_filter','invalid_order','invalid_range','invalid_body','invalid_session'].includes(error.message);
  return reply(inputError?400:503,{message:inputError?'invalid_gateway_request':'gateway_unavailable',request_id:requestId});
 }
}
