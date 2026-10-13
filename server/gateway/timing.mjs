export function requestTiming({region=process.env.VERCEL_REGION||'unknown',first=false}={}){
 const start=performance.now(),durations=new Map();let edgeRegion=null,authChecks=null;
 const measure=async(name,fn)=>{const began=performance.now();try{return await fn();}finally{durations.set(name,(durations.get(name)||0)+performance.now()-began);}};
 return {measure,edge(response){
  const value=response.headers.get('x-sb-edge-region');if(value&&/^[a-z0-9-]{1,40}$/.test(value))edgeRegion=value;
  const checks=response.headers.get('x-partnerdesk-edge-auth-checks');if(checks&&/^[0-9]{1,2}$/.test(checks))authChecks=checks;
  for(const part of (response.headers.get('server-timing')||'').split(',')){
   const match=part.trim().match(/^(e_[a-z_]{1,20});dur=([0-9]+(?:\.[0-9]+)?)$/);
   if(match)durations.set(match[1],Number(match[2]));
  }
 },record(){return {region,first,edge_region:edgeRegion,edge_auth_checks:authChecks===null?null:Number(authChecks),durations:Object.fromEntries([...durations].map(([name,ms])=>[name,Number(ms.toFixed(1))])),total_ms:Number((performance.now()-start).toFixed(1))};},headers(){return {'Server-Timing':[...durations].map(([name,ms])=>`${name};dur=${ms.toFixed(1)}`).concat(`total;dur=${(performance.now()-start).toFixed(1)}`).join(', '),
  'X-PartnerDesk-Function-Region':region,'X-PartnerDesk-Instance-First-Request':first?'1':'0',...(edgeRegion?{'X-PartnerDesk-Edge-Region':edgeRegion}:{}),...(authChecks?{'X-PartnerDesk-Edge-Auth-Checks':authChecks}:{})};}};
}
