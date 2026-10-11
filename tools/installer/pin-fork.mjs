// Fetch only public provenance metadata; binary input is a separately obtained local asset.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const params = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!key?.startsWith("--") || !value || params.has(key)) throw new Error("Invalid pin arguments");
  params.set(key,value);
}
const required = key => { const value = params.get(key); if (!value) throw new Error(`Missing ${key}`); return value; };
const tag = required("--tag");
const n = /^(?:v0\.17\.4-predict\.|predict-0\.17\.4\.)([1-9][0-9]*)$/.exec(tag)?.[1];
if (n === undefined) throw new Error("Fork tag must identify 0.17.4-predict.N");
const archive = path.resolve(required("--archive"));
const sevenzip = path.resolve(required("--sevenzip"));
const output = path.resolve(required("--output"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function run(exe,args) {
  const r = spawnSync(exe,args,{cwd:root,encoding:"utf8",windowsHide:true});
  if (r.error || r.status !== 0) throw new Error(`${path.basename(exe)}: ${r.error?.message ?? r.stderr}`);
  return r.stdout;
}
const api = endpoint => JSON.parse(run("gh",["api",`repos/CometDash77/weasel/${endpoint}`]));
const release = api(`releases/tags/${tag}`);
if (release.draft || release.prerelease || release.tag_name !== tag) throw new Error("A published stable fork release is required");
const asset = release.assets.find(a => a.name === path.basename(archive));
const bytes = readFileSync(archive);
const sha256 = hash(bytes);
if (!asset || asset.digest !== `sha256:${sha256}` || asset.size !== bytes.length) throw new Error("Local archive does not match the GitHub release asset digest/size");
let object = api(`git/ref/tags/${tag}`).object;
if (object.type === "tag") object = api(`git/tags/${object.sha}`).object;
if (object.type !== "commit") throw new Error("Tag must resolve to a commit");
const toolchain = JSON.parse(readFileSync(path.join(root,"tools/installer/toolchain.json"),"utf8"));
if (hash(readFileSync(sevenzip)) !== toolchain.sevenzip.exeSha256
    || hash(readFileSync(path.join(path.dirname(sevenzip),"7z.dll"))) !== toolchain.sevenzip.dllSha256) throw new Error("7-Zip tool hash mismatch");
const entries = [
  ["frontend", "weaselx64.dll"], ["frontend-x86", "weasel.dll"],
  ["setup", "WeaselSetup.exe"], ["server", "WeaselServer.exe"], ["rime", "rime.dll"],
  ["deployer", "WeaselDeployer.exe"], ["winsparkle", "WinSparkle.dll"],
  ["fork-license", "LICENSE.txt"], ["fork-readme", "README.txt"],
  ["start-service", "start_service.bat"], ["stop-service", "stop_service.bat"],
];
const temp = path.join(root,`build/installer/pin-${Date.now()}`);
mkdirSync(temp,{recursive:true});
run(sevenzip,["x","-y",`-o${temp}`,archive,...entries.map(([,name])=>name)]);
const files = entries.map(([role,name])=>{
  const data = readFileSync(path.join(temp,name));
  return {role,path:name,bytes:data.length,sha256:hash(data)};
});
const receipt = {
  format:1,releaseVerified:true,draft:false,prerelease:false,version:`0.17.4-predict.${n}`,
  tag,commit:object.sha,sourceUrl:`https://github.com/CometDash77/weasel/tree/${object.sha}`,
  releaseUrl:release.html_url,releaseId:release.id,assetId:asset.id,assetUrl:asset.browser_download_url,
  bytes:bytes.length,sha256,files,
};
mkdirSync(path.dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify(receipt,null,2)+"\n");
console.log("Pinned public fork release receipt: " + output);
