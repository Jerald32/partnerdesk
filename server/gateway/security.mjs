import {createHmac,createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';

export const PROOF_TTL_SECONDS=20;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION=/^[0-9a-f]{64}$/;

function ipv4Number(ip){return ip.split('.').reduce((n,part)=>(n<<8n)|BigInt(part),0n);}
function ipv6Number(ip){
 let input=ip.toLowerCase();
 if(input.includes('.')){
  const colon=input.lastIndexOf(':');const v4=input.slice(colon+1);
  if(isIP(v4)!==4)throw new Error('invalid_ip');
  const n=ipv4Number(v4);input=input.slice(0,colon+1)+(n>>16n).toString(16)+':'+(n&65535n).toString(16);
 }
 const halves=input.split('::');
 const left=halves[0]?halves[0].split(':'):[];
 const right=halves[1]?halves[1].split(':'):[];
 const parts=halves.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left;
 return parts.reduce((n,part)=>(n<<16n)|BigInt('0x'+part),0n);
}
export function parseIP(value){
 if(typeof value!=='string'||!value||value!==value.trim()||value.includes('%'))throw new Error('invalid_ip');
 const family=isIP(value);if(!family)throw new Error('invalid_ip');
 const number=family===4?ipv4Number(value):ipv6Number(value);
 // Match IPv4-mapped IPv6 consistently with native IPv4 allowlist entries.
 if(family===6&&(number>>32n)===65535n)return {family:4,bits:32,number:number&4294967295n};
 return {family,bits:family===4?32:128,number};
}
export function parseCIDR(value){
 if(typeof value!=='string'||value!==value.trim())throw new Error('invalid_cidr');
 const parts=value.split('/');if(parts.length>2)throw new Error('invalid_cidr');
 const ip=parseIP(parts[0]);
 const prefix=parts.length===1?ip.bits:/^(0|[1-9][0-9]{0,2})$/.test(parts[1])?Number(parts[1]):NaN;
 if(!Number.isInteger(prefix)||prefix<0||prefix>ip.bits)throw new Error('invalid_cidr');
 return {...ip,prefix,network:(ip.number>>BigInt(ip.bits-prefix))<<BigInt(ip.bits-prefix)};
}
export function matchesCIDR(ip,cidr){
 const source=parseIP(ip),network=parseCIDR(cidr);
 return source.family===network.family&&(source.number>>BigInt(source.bits-network.prefix))===(network.network>>BigInt(source.bits-network.prefix));
}
export function platformIP(headers,{vercel=process.env.VERCEL==='1'}={}){
 // Never fall back to an arbitrary forwarding header, request body or socket IP.
 if(!vercel)return null;
 const value=headers instanceof Headers?headers.get('x-vercel-forwarded-for'):headers['x-vercel-forwarded-for'];
 if(typeof value!=='string')return null;
 try{parseIP(value);return value;}catch{return null;}
}
export function evaluateIP(ip,policy){
 const enforced=policy.mode==='enforced';
 let matched=false,reason='not_allowlisted';
 if(ip===null)reason='trusted_ip_unavailable';
 else{
  try{parseIP(ip);matched=policy.entries.some(entry=>matchesCIDR(ip,entry));reason=matched?'allowlisted':reason;}
  catch{reason='invalid_ip_or_policy';}
 }
 return {allowed:!enforced||matched,wouldDeny:!matched,reason,mode:policy.mode};
}
function key(value){
 if(typeof value!=='string'||!/^[0-9a-f]{64}$/.test(value))throw new Error('gateway_key_not_configured');
 return Buffer.from(value,'hex');
}
export function sessionDigest(token){
 if(token===null||token===undefined)return null;
 if(!SESSION.test(token))throw new Error('invalid_session');
 return createHash('sha256').update(Buffer.from(token,'hex')).digest('hex');
}
export function signProof({ip,userId=null,sessionToken=null,path,method,body='',policyVersion},secret,{now=Date.now(),requestId=randomUUID()}={}){
 if(ip!==null)parseIP(ip);
 if(userId!==null&&!UUID.test(userId))throw new Error('invalid_subject');
 if(!UUID.test(requestId)||typeof path!=='string'||!path||!['POST','GET','HEAD'].includes(method))throw new Error('invalid_binding');
 const iat=Math.floor(now/1000);
 const payload=JSON.stringify({v:1,id:requestId,ip,sub:userId,session:sessionDigest(sessionToken),path,method,
  body:createHash('sha256').update(body).digest('hex'),policy:policyVersion,iat,exp:iat+PROOF_TTL_SECONDS});
 return {payload:Buffer.from(payload).toString('base64'),signature:createHmac('sha256',key(secret)).update(payload).digest('hex')};
}
export function verifyProof(proof,secret,binding,{now=Date.now()}={}){
 if(!proof||typeof proof.payload!=='string'||proof.payload.length>4096||!/^[A-Za-z0-9+/]+={0,2}$/.test(proof.payload)||
  typeof proof.signature!=='string'||!SESSION.test(proof.signature))throw new Error('invalid_gateway_proof');
 const raw=Buffer.from(proof.payload,'base64');
 const expected=createHmac('sha256',key(secret)).update(raw).digest();
 if(!timingSafeEqual(expected,Buffer.from(proof.signature,'hex')))throw new Error('invalid_gateway_proof');
 const p=JSON.parse(raw.toString());const clock=Math.floor(now/1000);
 if(p.v!==1||!UUID.test(p.id)||!Number.isSafeInteger(p.iat)||!Number.isSafeInteger(p.exp)||p.iat>clock+2||p.exp<=clock||p.exp-p.iat!==PROOF_TTL_SECONDS)
  throw new Error('expired_gateway_proof');
 if(p.sub!==binding.userId||p.session!==sessionDigest(binding.sessionToken)||p.path!==binding.path||p.method!==binding.method||
  p.body!==createHash('sha256').update(binding.body||'').digest('hex'))throw new Error('gateway_binding_mismatch');
 if(p.ip!==null)parseIP(p.ip);
 return p;
 // Signature validation alone does NOT establish one-time use. The POST DB/Edge
 // consumer must atomically persist p.id before processing the business action.
}
