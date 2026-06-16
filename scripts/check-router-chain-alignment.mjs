import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const routerFile = path.join(root, "lib", "llm-router.ts");
const modelsFile = path.join(root, "lib", "models.ts");

const router = fs.readFileSync(routerFile, "utf8");
const models = fs.readFileSync(modelsFile, "utf8");

const autoMatch = router.match(/export const FALLBACK_AUTO_CHAIN:\s*string\[\]\s*=\s*\[([\s\S]*?)\];/);
if (!autoMatch) {
  throw new Error("Could not find FALLBACK_AUTO_CHAIN in lib/llm-router.ts");
}
const autoChain = [...autoMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

const modelRows = [...models.matchAll(/\{\s*id:\s*"([^"]+)",\s*provider:\s*"([^"]+)"/g)];
const cloudChain = modelRows.map((m) => `${m[2] === "gemini" ? "google" : m[2]}/${m[1]}`);

const rankPatterns = [
  [/gpt-oss-120b/i, 10],
  [/llama-4-maverick/i, 18],
  [/llama-3\.3-70b/i, 20],
  [/qwen3-?coder|qwen3-?235/i, 28],
  [/deepseek/i, 32],
  [/qwen3-?32/i, 36],
  [/gemini-3|gemini-2\.5-pro/i, 40],
  [/gemini-2\.5-flash(?!-lite)/i, 50],
  [/mistral-(large|medium)/i, 55],
  [/llama-4-scout/i, 60],
  [/gpt-oss-20b/i, 65],
  [/gemini.*flash-lite/i, 70],
  [/qwen3-?(8|14|30)/i, 75],
];

function rank(model) {
  for (const [re, r] of rankPatterns) if (re.test(model)) return r;
  return 999;
}

const bestToWorst = [...cloudChain].sort((a, b) => {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b);
});

if (autoChain.join("\n") !== cloudChain.join("\n")) {
  console.error("Router fallback chain differs from cloud MODELS order.");
  console.error("FALLBACK_AUTO_CHAIN:");
  console.error(autoChain.map((m, i) => `  ${i + 1}. ${m}`).join("\n"));
  console.error("Cloud MODELS:");
  console.error(cloudChain.map((m, i) => `  ${i + 1}. ${m}`).join("\n"));
  process.exit(1);
}

if (!autoChain.includes("nvidia/meta/llama-4-maverick-17b-128e-instruct")) {
  console.error("FALLBACK_AUTO_CHAIN must include nvidia/meta/llama-4-maverick-17b-128e-instruct.");
  process.exit(1);
}

if (autoChain.join("\n") !== bestToWorst.join("\n")) {
  console.error("FALLBACK_AUTO_CHAIN / MODELS must be sorted best-to-worst by modelRank.");
  console.error("Actual:");
  console.error(autoChain.map((m, i) => `  ${i + 1}. ${m} (rank ${rank(m)})`).join("\n"));
  console.error("Expected:");
  console.error(bestToWorst.map((m, i) => `  ${i + 1}. ${m} (rank ${rank(m)})`).join("\n"));
  process.exit(1);
}

if (!/async function autoChain\(\)/.test(router) || !/from\(llmModels\)/.test(router)) {
  console.error("Router auto mode must use dynamic llmModels catalog before falling back.");
  process.exit(1);
}

console.log(`Router fallback alignment OK (${autoChain.length} fallback models); dynamic catalog enabled.`);
