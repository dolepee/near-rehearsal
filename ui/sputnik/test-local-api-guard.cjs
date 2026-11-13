'use strict';
const assert=require('node:assert/strict');
const {apiRequestError}=require('../local-api-guard.cjs');
const {server,repairManager,reviewManager}=require('./server.cjs');
const originalRepair=repairManager.start,originalReview=reviewManager.start;
let starts=0;
repairManager.start=reviewManager.start=()=>{starts++;return {id:'safe-manager-fixture'};};
const routes=['/api/repair/run','/api/review/runs','/api/run','/api/correction','/api/runs/nonexistent/verify','/api/runs/nonexistent/export','/api/patch/runs'];
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
 const origin='http://127.0.0.1:'+server.address().port;
 for(const route of routes){
  for(const contentType of ['text/plain','application/json']){const r=await fetch(origin+route,{method:'POST',headers:{origin:'https://foreign.example','content-type':contentType},body:'{}'});assert.equal(r.status,403,route);}
  for(const headers of [{},{'content-type':'text/plain'},{'content-type':'application/x-www-form-urlencoded'}]){const r=await fetch(origin+route,{method:'POST',headers:{origin,...headers},body:'{}'});assert.equal(r.status,415,route);}
 }
 assert.equal(starts,0,'denied requests reached a manager');
 for(const route of ['/api/repair/run','/api/review/runs']){const r=await fetch(origin+route,{method:'POST',headers:{origin,'content-type':'application/json; charset=utf-8'},body:'{}'});assert.equal(r.status,202);}
 assert.equal(starts,2,'same-origin JSON did not reach fixture managers');
 const hostStatus=await new Promise((resolve,reject)=>{const r=require('node:http').request(origin+'/api/health',{headers:{host:'foreign.example'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();});assert.equal(hostStatus,403);
 assert.equal((await fetch(origin+'/api/health')).status,200,'local CLI without Origin remains supported');
 assert.equal(apiRequestError({headers:{host:'localhost:4174',origin:'http://localhost:4174','content-type':'application/json'},method:'POST',socket:{remoteAddress:'203.0.113.5'}}).status,403);
 console.log('local API guard: all mutation routes reject foreign origins/types before managers; valid local JSON works');
}finally{repairManager.start=originalRepair;reviewManager.start=originalReview;await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;});
