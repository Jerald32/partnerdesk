import {randomUUID} from 'node:crypto';
import {platformIP,evaluateIP,signProof} from '../server/gateway/security.mjs';
import {readQuery,projection,RPCS} from '../server/gateway/transport.mjs';

function send(res,status,body,headers={}){
 res.statusCode=status;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
 for(const [key,value]of Object.entries(headers))res.setHeader(key,value);
 res.end(typeof body==='string'?body:JSON.stringify(body));
}
export default async function handler(req,res){
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
  if(!publicRpc){
   if(typeof authorization!=='string'||!/^Bearer [^\s]+$/i.test(authorization))return send(res,401,{message:'authentication_required'});
   const auth=await fetch(new URL('/auth/v1/user',base),{headers:{apikey:publishable,Authorization:authorization},signal:AbortSignal.timeout(10000)});
   if(!auth.ok)return send(res,401,{message:'invalid_jwt'});
   const user=await auth.json();if(typeof user.id!=='string')throw new Error('invalid_identity');userId=user.id;
  }
  const policyResponse=await call('/rest/v1/rpc/backend_gateway_policy',{},true);if(!policyResponse.ok)throw new Error('policy_unavailable');
  const policy=await policyResponse.json(),ip=platformIP(req.headers),verdict=evaluateIP(ip,policy);
  if(verdict.wouldDeny){
   const audit=await call('/rest/v1/rpc/backend_gateway_audit',{p_user:userId,p_ip:ip,p_path:route,
    p_verdict:verdict.allowed?'monitor_would_deny':'ip_denied',p_request_id:requestId},true);
   if(!audit.ok)throw new Error('audit_unavailable');
  }
  if(!verdict.allowed)return send(res,403,{message:'ip_not_allowed',request_id:requestId});
  const sessionToken=req.headers['x-partnerdesk-session']||null;
  let body;
  if(read)body=JSON.stringify(read.request);
  else{
   const input=typeof req.body==='string'?JSON.parse(req.body):req.body;
   if(!input||typeof input!=='object'||Array.isArray(input)||JSON.stringify(input).length>65536)throw new Error('invalid_body');
   body=isEdge?JSON.stringify(input):JSON.stringify({name:rpc,args:input});
  }
  const path=isEdge?'functions/app-auth':read?'rpc/gateway_read':'rpc/gateway_rpc';
  const proof=signProof({ip,userId,sessionToken,path,method:'POST',body,policyVersion:policy.version},key,{requestId});
  const headers={'X-PartnerDesk-Proof':proof.payload,'X-PartnerDesk-Signature':proof.signature};
  if(sessionToken)headers['X-PartnerDesk-Session']=sessionToken;
  if(isEdge)headers.Origin='https://partnerdesk-phi.vercel.app';
  const target=isEdge?'/functions/v1/app-auth':'/rest/v1/'+path;
  const result=isEdge?await fetch(new URL(target,base),{method:'POST',headers:{apikey:publishable,Authorization:authorization,'Content-Type':'application/json',...headers},body,signal:AbortSignal.timeout(20000)}):await call(target,{p_request:body},false,headers);
  if(!result.ok){const failure=await result.json().catch(()=>({}));
   return send(res,result.status,{message:typeof failure.message==='string'?failure.message:'backend_rejected',code:failure.code,success:false,reason:failure.reason});
  }
  const data=await result.json();
  if(data?._gateway_error)return send(res,data._gateway_error.code==='42501'?403:400,data._gateway_error);
  if(!read)return send(res,200,data);
  if(!Array.isArray(data.rows)||!Number.isSafeInteger(data.count))throw new Error('invalid_response');
  const rows=data.rows.map(row=>projection(row,read.fields));
  const responseHeaders={'Content-Range':rows.length?`${read.request.offset}-${read.request.offset+rows.length-1}/${data.count}`:`*/${data.count}`};
  if(req.headers.accept?.includes('application/vnd.pgrst.object+json')){
   if(rows.length!==1)return send(res,406,{code:'PGRST116',message:'Expected one row'},responseHeaders);
   return send(res,200,rows[0],responseHeaders);
  }
  return send(res,200,rows,responseHeaders);
 }catch(error){
  const inputError=['route_not_allowed','invalid_table','invalid_select','unsupported_filter','invalid_filter','invalid_order','invalid_range','invalid_body','invalid_session'].includes(error.message);
  return send(res,inputError?400:503,{message:inputError?'invalid_gateway_request':'gateway_unavailable',request_id:requestId});
 }
}
