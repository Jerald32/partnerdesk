import {validatePassword} from '../../../src/lib/password.js';

export function createPasswordHandler(services) {
 return async request=>{
  const origin=request.headers.get('origin');
  const allowed=['https://partnerdesk-phi.vercel.app','https://partnerdesk-716-7c9a.vercel.app',
   'http://127.0.0.1:5173','http://localhost:5173'].includes(origin);
  const headers={'Cache-Control':'no-store',...(allowed?{'Access-Control-Allow-Origin':origin,'Vary':'Origin',
   'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS'}:{})};
  const reply=(status,body)=>Response.json(body,{status,headers});
  if(origin&&!allowed)return reply(403,{error:'origin_not_allowed'});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(request.method!=='POST')return reply(405,{error:'method_not_allowed'});
  try {
   const raw=await request.text();if(raw.length>16384)return reply(413,{error:'request_too_large'});
   const body=JSON.parse(raw);
   if(!['signup','reset'].includes(body?.action))return reply(400,{error:'invalid_action'});
   if(!validatePassword(body.password).valid)return reply(422,{error:'weak_password'});
   let userId,email,name,consents,jwt;
   if(body.action==='reset') {
    const match=/^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization')||'');
    const user=match?await services.authenticate(match[1]):null;
    if(!user)return reply(401,{error:'authentication_required'});
    userId=user.id;jwt=match[1];
   } else {
    email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
    name=typeof body.name==='string'?body.name.trim():'';
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>320||!name||name.length>200||!Array.isArray(body.signup_consents)||body.signup_consents.length>3)return reply(400,{error:'invalid_signup'});
    consents=body.signup_consents;userId=services.randomUUID();
   }
   await services.reserve({userId,operation:body.action,email});
   const hash=await services.hash(body.password);
   const approval=await services.approve({userId,hash,operation:body.action,email});
   if(body.action==='reset')await services.updatePassword(jwt,body.password);
   else {
    await services.createUser({email,password:body.password,proofToken:approval.proof_token,name,consents});
   }
   return reply(200,{success:true});
  } catch(error) {
   return reply(error?.code==='54000'?429:503,{error:error?.code==='54000'?'rate_limited':'password_request_failed'});
  }
 };
}
