const cp=require('child_process');
const deployment=process.argv[2];if(!/^partnerdesk-[a-z0-9-]+\.vercel\.app$/.test(deployment))throw Error('deployment_required');
const samples=[];
for(let i=0;i<3;i++){
 const command='npx.cmd vercel curl /api/gateway?gateway_path=rest/v1/rpc/list_signup_consent_policies --deployment '+deployment+' -- -i -X POST -H Content-Type:application/json --data {} -w PD_TIME:%{time_total}';
 const r=cp.spawnSync('cmd.exe',['/d','/s','/c',command],{encoding:'utf8',timeout:25000,windowsHide:true});
 const get=name=>r.stdout.match(new RegExp('^'+name+': ([^\\r\\n]+)','im'))?.[1];
 const sample={status:Number(r.stdout.match(/HTTP\/\S+ (\d+)/)?.[1]),client_ms:Number(r.stdout.match(/PD_TIME:([0-9.]+)/)?.[1])*1000,
 region:get('x-partnerdesk-function-region'),first:get('x-partnerdesk-instance-first-request'),timing:get('server-timing')};
 samples.push(sample);console.log(JSON.stringify(sample));if(sample.status!==200)process.exit(1);
}
const sorted=samples.map(x=>x.client_ms).sort((a,b)=>a-b);console.log(JSON.stringify({median_client_ms:sorted[1]}));
