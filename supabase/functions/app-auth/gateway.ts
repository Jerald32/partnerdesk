import { sessionHash } from './crypto.ts';
import { HttpError } from './http.ts';
import type { Services } from './handler.ts';

export async function consumeGateway(req:Request,services:Services){
 const payload=req.headers.get('x-partnerdesk-proof'),signature=req.headers.get('x-partnerdesk-signature');
 if(!payload||!signature||payload.length>4096||!/^Bearer [^\s]+$/i.test(req.headers.get('authorization')||''))throw new HttpError(403,'gateway_required');
 const jwt=req.headers.get('authorization')!.slice(7);
 const user=await services.authenticate(jwt);
 const token=req.headers.get('x-partnerdesk-session');
 if(token&&!/^[0-9a-f]{64}$/.test(token))throw new HttpError(400,'invalid_session_token');
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(await req.clone().text()));
 const bodyHash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
 const result=await services.rpc('backend_gateway_consume',{p_payload:payload,p_signature:signature,p_user:user.id,p_session:token?await sessionHash(token):null,p_body:bodyHash});
 if(result.sub!==user.id)throw new HttpError(403,'gateway_required');
}
