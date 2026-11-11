import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
const root=process.cwd(),destination=path.join(root,'.release/inactivity-app');
const deployment='dpl_ztrQBUwx8RhKvtoLjHQvVb8siud3';
const manifest=JSON.parse(fs.readFileSync('.release/inactivity-production-manifest.json','utf8').replace(/^\uFEFF/,''));
const hash=bytes=>crypto.createHash('sha1').update(bytes).digest('hex');
function flatten(nodes,prefix=''){return nodes.flatMap(n=>{const file=prefix?prefix+'/'+n.name:n.name;return n.type==='file'?[{file,hash:n.uid}]:flatten(n.children||[],file);});}
const selected=flatten(manifest).filter(x=>x.file.startsWith('src/')).map(x=>({...x,file:x.file.slice(4)}))
 .filter(x=>/^(src\/|api\/|server\/|public\/)/.test(x.file)||/^(package(-lock)?\.json|index\.html|components\.json|jsconfig\.json|postcss\.config\.js|tailwind\.config\.js|vite\.config\.js|vercel\.json)$/.test(x.file));
const changed=[];
for(const item of selected){
 const local=path.join(root,item.file),target=path.join(destination,item.file);
 let bytes=fs.existsSync(local)?fs.readFileSync(local):null;
 if(!bytes||hash(bytes)!==item.hash){
  const result=cp.spawnSync('cmd.exe',['/d','/s','/c',`npx.cmd vercel api /v8/deployments/${deployment}/files/${item.hash} --scope 716-7c9a --raw`],{encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:12*1024*1024});
  if(result.status!==0)throw Error('production_source_read_failed: '+item.file);
  bytes=Buffer.from(JSON.parse(result.stdout).data,'base64');changed.push(item.file);
 }
 if(hash(bytes)!==item.hash)throw Error('production_source_hash_mismatch: '+item.file);
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
}
// Overlay only this task's changes onto the exact running production source.
for(const file of ['src/components/users/UserAccessRow.jsx','src/components/settings/LifecycleReview.jsx','src/lib/accountStatus.js'])
 fs.copyFileSync(path.join(root,file),path.join(destination,file));
const management=path.join(destination,'src/pages/UserManagement.jsx');
let text=fs.readFileSync(management,'utf8');
const before="{['suspended','disabled'].includes(profile.account_status) && <p className=\"text-xs text-muted-foreground\">{profile.account_status === 'disabled' ? '비활성화' : '정지'}</p>}";
const after="{['inactive_warning','suspended','disabled'].includes(profile.account_status) && <p className=\"text-xs text-muted-foreground\">{profile.account_status === 'inactive_warning' ? '미접속 경고' : profile.account_status === 'disabled' ? '비활성화' : '차단'}</p>}";
if(!text.includes(before))throw Error('production_user_status_markup_changed');
fs.writeFileSync(management,text.replace(before,after));
fs.mkdirSync(path.join(destination,'.vercel'),{recursive:true});
fs.copyFileSync('.vercel/project.json',path.join(destination,'.vercel/project.json'));
fs.writeFileSync(path.join(destination,'.vercelignore'),'node_modules\n.env*\n');
// Reuse installed dependencies for local verification; Vercel installs its own.
if(!fs.existsSync(path.join(destination,'node_modules')))fs.symlinkSync(path.join(root,'node_modules'),path.join(destination,'node_modules'),'junction');
console.log(JSON.stringify({source_deployment:deployment,files:selected.length,production_files_restored:changed,destination}));
