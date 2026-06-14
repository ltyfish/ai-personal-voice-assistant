import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p) => {
  try {
    return fs.readFileSync(path.join(root, p), "utf8");
  } catch {
    return "";
  }
};
const router = read("lib/llm-router.ts");
const schema = read("db/schema.ts");
const llmModelsRoute = read("app/api/llm-models/route.ts");
const llmKeysUsageRoute = read("app/api/llm-keys/usage/route.ts");
const llmKeys = read("components/LLMKeys.tsx");

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  }
}

assert(/export const llmModels = pgTable\(\s*"llm_models"/s.test(schema), "schema must define llm_models catalog table.");
assert(/unique\("llm_models_platform_model"\)/.test(schema), "llm_models must be unique by platform+model.");
assert(/async function autoChain/.test(router), "router must build auto chain dynamically.");
assert(/from\(llmModels\)/.test(router), "auto chain must read llmModels, not only a hardcoded list.");
assert(/eq\(llmModels\.enabled,\s*true\)/.test(router), "auto chain must only include enabled catalog models.");
assert(/enabledPlatforms/.test(router), "auto chain must filter models to providers with enabled keys.");
assert(/FALLBACK_AUTO_CHAIN/.test(router), "router should keep the small static chain only as a fallback.");
assert(/export const FALLBACK_AUTO_CHAIN/.test(router), "router fallback chain must be exported so dashboards can surface every rotated fallback model.");
assert(/"nvidia\/meta-llama\/llama-4-maverick-17b-128e-instruct"/.test(router), "router fallback chain must include NVIDIA Llama 4 Maverick so it appears in LLM Keys.");
assert(/disabledModelIds/.test(router), "auto fallback chain must load disabled llm_models rows so fallback models disabled in the UI are skipped.");
assert(/fallbackAutoChain\(\)/.test(router), "auto fallback chain must pass through a helper that removes disabled UI rows before cooldown filtering.");
assert(/export async function POST/.test(llmModelsRoute) && /onConflictDoUpdate/.test(llmModelsRoute), "llm-models route must bulk upsert catalog rows.");
assert(/enabled:\s*llmModels\.enabled/.test(llmModelsRoute), "catalog refresh must preserve manual model enable/disable choices.");
assert(/export async function PATCH/.test(llmModelsRoute) && /enabled:\s*body\.enabled/.test(llmModelsRoute), "llm-models route must let users toggle model enabled state.");
assert(/onConflictDoUpdate/.test(llmModelsRoute) && /source:\s*"manual"/.test(llmModelsRoute), "llm-models PATCH must upsert missing fallback/usage models so toggles persist.");
assert(/FALLBACK_AUTO_CHAIN/.test(llmKeysUsageRoute), "LLM Keys usage endpoint must include fallback auto-chain models that can be rotated before first use.");
assert(/source:\s*"fallback"/.test(llmKeysUsageRoute), "Fallback auto-chain rows must be identifiable in LLM Keys usage output.");
assert(/syncModelCatalog/.test(llmKeys) && /\/api\/llm-models/.test(llmKeys), "LLM Keys UI must sync bridge/freellmapi catalog into native llm_models.");
assert(/function toggleModel/.test(llmKeys) && /modelBusy/.test(llmKeys) && /Disabled: skipped by auto rotation/.test(llmKeys), "LLM Keys UI must expose per-model enable/disable controls.");

if (process.exitCode) process.exit(1);
console.log("Router catalog rotation checks OK.");
