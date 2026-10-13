const {spawn,execFileSync}=require('child_process'); const os=require('os'),path=require('path'),fs=require('fs');
const f=path.join(os.tmpdir(),'proto-recv-deno7.jsonl'); try{fs.rmSync(f,{force:true})}catch{}
const proto='D:/Documents/vibe/RIME-PredictInput/prototype/sidecar-artifact';
const recv=spawn(path.join(proto,'helper.exe'),['recv',f,'30000'],{stdio:'ignore'});
let ok=false; for(let i=0;i<30&&!ok;i++){const end=Date.now()+100; while(Date.now()<end){} try{ok=JSON.parse(fs.readFileSync(f,'utf8')).ready===true}catch{}}
console.log('ready='+ok);
const out=execFileSync(path.join(proto,'artifacts','probe-deno.exe'),['send','deno'+String.fromCharCode(10)+'req-1'+String.fromCharCode(10)+'1'],{timeout:20000});
console.log('DENO: '+out.toString().trim());
setTimeout(()=>{ try { console.log('recv: '+fs.readFileSync(f,'utf8')) } catch(e){ console.log('err '+e.message) } process.exit(0) }, 800);