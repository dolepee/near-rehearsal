'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{spawnSync}=require('node:child_process');
const fixtures=require('./test-patch-fixtures.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rehearsal-patch-life-'));
(async()=>{
 fs.mkdirSync(path.join(dir,'ui/sputnik'),{recursive:true});fs.mkdirSync(path.join(dir,'scripts'));fs.mkdirSync(path.join(dir,'case-triage/rehearsal-repair'),{recursive:true});
 fs.copyFileSync(path.join(__dirname,'patch-route.cjs'),path.join(dir,'ui/sputnik/patch-route.cjs'));
 fs.copyFileSync(path.join(__dirname,'../../case-triage/rehearsal-repair/review-bundle.cjs'),path.join(dir,'case-triage/rehearsal-repair/review-bundle.cjs'));
 fs.copyFileSync(path.join(__dirname,'../../case-triage/rehearsal-repair/mixed-policy-identity.cjs'),path.join(dir,'case-triage/rehearsal-repair/mixed-policy-identity.cjs'));
 fixtures.validatorFiles(dir);
 fs.writeFileSync(path.join(dir,'case-triage/rehearsal-repair/controller-manifest.json'),JSON.stringify({source:{commit:'fixture'}}));
 fs.writeFileSync(path.join(dir,'scripts/review-patch.cjs'),`const fs=require('fs'),{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(path.join(dir,'pids.json'))},JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`);
 const adapter=require(path.join(dir,'ui/sputnik/patch-route.cjs'));
 const send=(res,n,obj)=>{res.writeHead(n,{'content-type':'application/json'});res.end(JSON.stringify(obj));};
 const server=http.createServer((req,res)=>adapter.handle({req,res,url:new URL(req.url,'http://localhost'),send}).catch(e=>send(res,400,{error:e.message})));
 process.env.REPAIR_SOURCE_DIR=dir;process.env.REPAIR_SANDBOX_DIR=dir;
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
 const url='http://127.0.0.1:'+server.address().port;
 const r=await fetch(url+'/api/patch/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({patch:'fixture diff'})});assert.equal(r.status,202);
 for(let i=0;i<100&&!fs.existsSync(path.join(dir,'pids.json'));i++)await new Promise(r=>setTimeout(r,20));
 const pids=JSON.parse(fs.readFileSync(path.join(dir,'pids.json')));
 await adapter.shutdown();
 for(let i=0;i<100;i++){if(pids.every(pid=>spawnSync('ps',['-p',String(pid)]).status!==0))break;await new Promise(r=>setTimeout(r,20));}
 for(const pid of pids)assert.notEqual(spawnSync('ps',['-p',String(pid)]).status,0,'checker descendant survived shutdown');
 console.log('patch lifecycle: shutdown removes checker and child process');
 }finally{await adapter.shutdown();await new Promise(r=>server.close(r));}
})().finally(()=>fs.rmSync(dir,{recursive:true,force:true})).catch(e=>{console.error(e);process.exitCode=1;});
