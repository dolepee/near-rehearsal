'use strict';
// Adapter only. Candidate acceptance belongs to the versioned CLI.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const cli = path.join(root, 'scripts/review-patch.cjs');
const output = path.join(root, '.local/browser-patch-runs');
const manifest = require('../../case-triage/rehearsal-repair/controller-manifest.json');
const names = {status:'review-status.json',report:'review-report.md',patch:'submitted.patch'};
const max = 65536;
const memory = new Map();
let active = null;
let currentChild = null;
let stopping = false;
function artifact(dir,key) {
  const f = key === 'patch' ? path.join(dir,names.patch) : path.join(dir,'evidence',names[key]);
  try {
    if(fs.realpathSync(f)!==f || !fs.lstatSync(f).isFile() || fs.statSync(f).size>1024*1024) return null;
    return fs.readFileSync(f);
  } catch { return null; }
}
function finish(job,dir,code,signal) {
  let obj = null;
  try { obj=JSON.parse(artifact(dir,'status')); } catch {}
  const label = typeof obj?.status === 'string' ? obj.status.toLowerCase().replace(/-/g,'_') : '';
  const valid = ['accepted','rejected','input_error','build_error','inconclusive'].includes(label);
  const report = artifact(dir,'report');
  job.status = (!signal && valid && (label !== 'accepted' || (code===0 && Boolean(report?.length)))) ? label : 'inconclusive';
  job.note = ({accepted:'The candidate passed the declared checks for this local Sputnik case.',rejected:'The candidate failed a defined check. Inspect the report before considering an upgrade.',input_error:'The checker could not apply this input. No economic conclusion follows.',build_error:'Compilation failed before the money checks could finish.',inconclusive:'No complete, recognized checker verdict was available.'})[job.status];
  job.report = report?.toString('utf8'); job.downloads = Object.keys(names).filter(k => artifact(dir,k));
}
async function body(req) {
  let n=0; const chunks=[]; for await(const chunk of req){ n+=chunk.length; if(n>max*6+128)throw new Error('Patch request too large.'); chunks.push(chunk); }
  const {patch}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(typeof patch!=='string'||!patch.trim()||Buffer.byteLength(patch)>max)throw new Error('Enter a source diff of up to 64 KiB.');
  return patch;
}
async function handle({req,res,url,send}) {
  // This endpoint is for a local operator. Never accept a cross-site submission.
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?$/.test(req.headers.host||'') ||
      !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
      (req.headers.origin && req.headers.origin!=='http://'+req.headers.host)) return send(res,403,{error:'Use the local Rehearsal server.'});
  if (url.pathname==='/api/patch/runs' && req.method==='POST') {
    if(req.headers['content-type']?.split(';')[0]!=='application/json')return send(res,415,{error:'Expected a JSON patch request.'});
    const patch=await body(req);
    if(stopping)return send(res,503,{error:'Server is stopping.'});
    if(active)return send(res,409,{error:'A patch check is already running. Wait for it to finish.'});
    if(!fs.existsSync(cli))return send(res,503,{error:'The patch checker is not installed in this build. Your diff has not been run.'});
    if(!process.env.REPAIR_SOURCE_DIR || !process.env.REPAIR_SANDBOX_DIR)return send(res,503,{error:'Configure the pinned source and local Sandbox before running a patch.'});
    const id=crypto.randomUUID(), dir=path.join(output,id), input=path.join(dir,names.patch);
    fs.mkdirSync(dir,{recursive:true,mode:0o700}); fs.writeFileSync(input,patch,{flag:'wx',mode:0o600});
    const args=[cli,'--patch',input,'--base',manifest.source.commit,'--source',path.resolve(process.env.REPAIR_SOURCE_DIR),'--out',path.join(dir,'evidence')];
    const job={id,status:'running'}; memory.set(id,job); active=id;
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['HOME','PATH','TMPDIR','LANG','CARGO_HOME','RUSTUP_HOME','REPAIR_SANDBOX_DIR','CARGO_NET_OFFLINE'].includes(k)));
    let child;
    try {child=spawn(process.execPath,args,{cwd:root,env,stdio:'ignore',detached:true});}
    catch(e){active=null; job.status='inconclusive'; return send(res,503,{error:'The local checker could not start.'});}
    currentChild = child;
    const timer=setTimeout(()=>{if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{}}},20*60*1000); timer.unref();
    child.on('error',()=>{}); child.once('close',(code,signal)=>{clearTimeout(timer);try{finish(job,dir,code,signal);}finally{active=null; currentChild=null;}});
    return send(res,202,job);
  }
  const m=url.pathname.match(/^\/api\/patch\/runs\/([a-f0-9-]{36})(?:\/(status|report|patch))?$/);
  if(req.method==='GET' && m && memory.has(m[1])){
    const job=memory.get(m[1]); if(!m[2])return send(res,200,job);
    if(!job.downloads?.includes(m[2]))return send(res,404,{error:'Evidence is unavailable.'});
    const bytes=artifact(path.join(output,m[1]),m[2]); if(!bytes)return send(res,404,{error:'Evidence is unavailable.'});
    res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store','content-disposition':'attachment; filename="'+names[m[2]]+'"'});return res.end(bytes);
  }
  return send(res,404,{error:'Unknown patch review.'});
}
async function shutdown() {
  stopping = true;
  const child = currentChild;
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  await new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', resolve);
    const timeout = setTimeout(resolve, 3000); timeout.unref();
  });
}
module.exports={handle, shutdown};
