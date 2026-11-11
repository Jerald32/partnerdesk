import {createClient} from 'npm:@supabase/supabase-js@2.95.0';
import bcrypt from 'npm:bcryptjs@3.0.3';
import {createPasswordHandler} from './handler.mjs';
const env=(key:string)=>Deno.env.get(key)??'';
const base=env('SUPABASE_URL'),secret=env('SUPABASE_SERVICE_ROLE_KEY');
const admin=createClient(base,secret,{auth:{persistSession:false,autoRefreshToken:false}});
async function nativeAuth(path:string,method:string,body:Record<string,unknown>,jwt?:string){
 const result=await fetch(base+'/auth/v1/'+path,{method,headers:{apikey:env('SUPABASE_ANON_KEY'),
  ...(jwt?{Authorization:'Bearer '+jwt}:{}),'Content-Type':'application/json'},
  body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 if(!result.ok)throw new Error('auth_write_failed');
}
Deno.serve(createPasswordHandler({
 randomUUID:()=>crypto.randomUUID(),hash:(password:string)=>bcrypt.hash(password,10),
 async authenticate(jwt:string){const {data,error}=await admin.auth.getUser(jwt);return error?null:data.user;},
 async reserve({userId,operation,email}:{userId:string;operation:string;email?:string}){
  const {error}=await admin.rpc('backend_reserve_password_request',{p_user_id:userId,p_operation:operation,p_email:email??null});
  if(error)throw Object.assign(new Error('password_rate_check_failed'),{code:error.code});
 },
 async approve({userId,hash,operation,email}:{userId:string;hash:string;operation:string;email?:string}){
  const {data,error}=await admin.rpc('backend_approve_password_write',{p_user_id:userId,p_hash:hash,p_operation:operation,p_email:email??null});
  if(error)throw Object.assign(new Error('password_approval_failed'),{code:error.code});
  return data;
 },
 async createUser({email,password,proofToken,name,consents}:{email:string;password:string;proofToken:string;name:string;consents:unknown[]}){
  await nativeAuth('signup?redirect_to='+encodeURIComponent('https://partnerdesk-phi.vercel.app/auth/confirm'),'POST',
   {email,password,data:{full_name:name,signup_consents:consents,_partnerdesk_password_approval:proofToken}});
 },
 async updatePassword(jwt:string,password:string){await nativeAuth('user','PUT',{password},jwt);},
}));