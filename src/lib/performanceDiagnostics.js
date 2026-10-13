import {diagnosticsEnabled,performancePages,onPerformancePages,resetPerformancePages} from './performanceTelemetry';
import {getAppSession} from './appSession';
let cancelCurrent=null,currentToken=null;
export function schedulePerformanceComparison(supabase,user){
 if(!diagnosticsEnabled()||user.role!=='admin'||user.organization?.type!=='operator')return;
 const initial=getAppSession();if(!initial)return;
 if(currentToken===initial.token)return;
 cancelCurrent?.();currentToken=initial.token;resetPerformancePages();let started=false,cancelled=false,timer=null;
 const notify=()=>{
  if(started||performancePages().length<2)return;
  started=true;timer=setTimeout(()=>{void compare();},2000);
 };
 async function compare(){
  const session=(await supabase.auth.getSession()).data?.session;
  if(cancelled||!session||getAppSession()?.token!==initial.token)return;
  // Two baseline/candidate pairs. Existing validated access only; no touch,
  // business mutation, identity export or temporary IP/security exception.
  for(const baseline of [true,false,true,false]){
   if(cancelled||getAppSession()?.token!==initial.token)return;
   const result=await fetch('/api/gateway?gateway_path=functions/v1/app-auth',{
    method:'POST',headers:{Authorization:'Bearer '+session.access_token,'X-PartnerDesk-Session':initial.token,
     'Content-Type':'application/json','X-PartnerDesk-Performance-Pages':JSON.stringify(performancePages()),
     ...(baseline?{'X-PartnerDesk-Performance-Baseline':'1'}:{})},body:JSON.stringify({action:'validate-session'}),signal:AbortSignal.timeout(20000),
   }).catch(()=>null);
   if(!result?.ok)return;
   await result.arrayBuffer();
  }
 }
 const unsubscribe=onPerformancePages(notify);notify();
 cancelCurrent=()=>{cancelled=true;clearTimeout(timer);unsubscribe();};
}
