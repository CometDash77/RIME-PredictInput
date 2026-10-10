// 一次性脚本：按 #6 冻结口径重生成正臂 fixture（词库内深位样本=目标，其余=主 schema 首位候选）。
import { readFileSync, writeFileSync } from "node:fs";
import { buildLexicon, completeCandidates } from "../../dist/eval/dicts.js";

const manifest = JSON.parse(readFileSync("eval/holdout/manifest.json", "utf8"));
const samples = readFileSync("eval/holdout/samples.jsonl", "utf8")
  .split("\n")
  .filter((l) => l !== "")
  .map((l) => JSON.parse(l));
const prev = JSON.parse(readFileSync("eval/fixtures/fixtures-positive-responses.json", "utf8"));

const schemaName = Object.keys(manifest.schemas)[0];
const short = manifest.schemas[schemaName].repo.split("/")[1];
const files = Object.keys(manifest.schemas[schemaName].files).map((f) => ({
  name: f,
  content: readFileSync("eval/.cache/dicts/" + short + "/" + f, "utf8"),
}));
const lex = buildLexicon(files);

let hits = 0, standins = 0, emptyFallback = 0, boundary = 0;
const out = {};
for (const s of samples) {
  if (s.kind === "boundary") { out[s.id] = prev[s.id]; boundary += 1; continue; }
  const labels = s.labels?.[schemaName];
  if (labels?.inside_complete === true) { out[s.id] = s.target; hits += 1; continue; }
  const ranked = completeCandidates(lex, s.pinyin);
  if (ranked.length === 0) { out[s.id] = ""; emptyFallback += 1; continue; }
  out[s.id] = ranked[0].text;
  standins += 1;
}
writeFileSync("eval/fixtures/fixtures-positive-responses.json", JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ total: samples.length, schema: schemaName, hits, standins, emptyFallback, boundary }));
