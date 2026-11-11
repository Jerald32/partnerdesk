import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
const [deployment='dpl_9LPFyjAUuKN9jVBnB4zW6qcv4XFK',manifestFile='.release/session-timeout-production-manifest.json',target='.release/session-timeout-app',...changedFiles]=process.argv.slice(2);
const root=process.cwd(),destination=path.join(root,target);
const overlays=new Set(changedFiles.length?changedFiles:['src/hooks/useIdleTimeout.jsx','src/lib/appAuth.js','src/pages/PrivacyNotice.jsx']);
const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8').replace(/^\uFEFF/,''));
const hash=bytes=>crypto.createHash('sha1').update(bytes).digest('hex');
function flatten(nodes,prefix=''){return nodes.flatMap(n=>{const file=prefix?prefix+'/'+n.name:n.name;return n.type==='file'?[{file,hash:n.uid}]:flatten(n.children||[],file);});}
const selected=flatten(manifest).filter(x=>x.file.startsWith('src/')).map(x=>({...x,file:x.file.slice(4)}))
 .filter(x=>/^(src\/|api\/|server\/|public\/)/.test(x.file)||/^(package(-lock)?\.json|index\.html|components\.json|jsconfig\.json|postcss\.config\.js|tailwind\.config\.js|vite\.config\.js|vercel\.json)$/.test(x.file));
const restored=[];
for(const item of selected){
 const local=path.join(root,item.file),target=path.join(destination,item.file);
 let bytes=fs.existsSync(local)?fs.readFileSync(local):null;
 if(!overlays.has(item.file)&&(!bytes||hash(bytes)!==item.hash)){
  const result=cp.spawnSync('cmd.exe',['/d','/s','/c',`npx.cmd vercel api /v8/deployments/${deployment}/files/${item.hash} --scope 716-7c9a --raw`],{encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:12*1024*1024});
  if(result.status!==0)throw Error('production_source_read_failed: '+item.file);
  bytes=Buffer.from(JSON.parse(result.stdout).data,'base64');restored.push(item.file);
 }
 if(!bytes||(!overlays.has(item.file)&&hash(bytes)!==item.hash))throw Error('production_source_hash_mismatch: '+item.file);
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
}
for(const overlay of overlays)if(!selected.some(item=>item.file===overlay)){
 if(!overlay.startsWith('src/')||overlay.includes('..')||!fs.existsSync(path.join(root,overlay)))throw Error('invalid_new_overlay: '+overlay);
 const targetFile=path.join(destination,overlay);fs.mkdirSync(path.dirname(targetFile),{recursive:true});
 fs.copyFileSync(path.join(root,overlay),targetFile);
}
fs.mkdirSync(path.join(destination,'.vercel'),{recursive:true});
fs.copyFileSync('.vercel/project.json',path.join(destination,'.vercel/project.json'));
fs.writeFileSync(path.join(destination,'.vercelignore'),'node_modules\n.env*\n');
if(!fs.existsSync(path.join(destination,'node_modules')))fs.symlinkSync(path.join(root,'node_modules'),path.join(destination,'node_modules'),'junction');
console.log(JSON.stringify({source_deployment:deployment,files:selected.length,overlays:[...overlays],restored,destination}));
