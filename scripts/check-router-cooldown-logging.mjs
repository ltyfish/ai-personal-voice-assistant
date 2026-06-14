import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p) => readFileSync(join(root, p), "utf8");
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  }
};

const router = read("lib/llm-router.ts");
const bridge = read("scripts/bridge/server.mjs");

assert(
  /appendRouterCooldownLog\(/.test(router),
  "llm-router must append rate-limit/client-error/server/network cooldown events to Router Cooldowns.md."
);

assert(
  /Recent router failures/.test(router) &&
    /kind:\s*"rate_limit"/.test(router) &&
    /kind:\s*"client_error"/.test(router),
  "Router cooldown logging must classify rate limits separately from client errors."
);

assert(
  /markModelCooldown\(/.test(router) &&
    /getModelCooldown\(/.test(router) &&
    /filterAvailableModels\(/.test(router) &&
    /normalizeModelCooldownId/.test(router),
  "llm-router must persist and check cooldowns per model id, not only per key or provider/model."
);

assert(
  /pushRouterEvent\(\{\s*kind:\s*"cooldown"[\s\S]*model cooldown/.test(router),
  "llm-router must emit a cooldown skip event when a model is model-cooled before trying keys."
);

assert(
  /kind:\s*"model_skip"/.test(router) &&
    /model cooldown skip/.test(router),
  "llm-router must log model cooldown skip events to Router Cooldowns.md, not only failures."
);

assert(
  /kind:\s*"model_cooldown"/.test(router) &&
    /model cooldown set for/.test(router),
  "llm-router must log model cooldown creation to Router Cooldowns.md immediately, not only later skip events."
);

assert(
  /async function fallbackAutoChain\(\)/.test(router) &&
    /return await filterAvailableModels\(FALLBACK_AUTO_CHAIN\.filter/.test(router) &&
    /if \(!platforms\.size\) return await fallbackAutoChain\(\)/.test(router) &&
    /return await fallbackAutoChain\(\)/.test(router),
  "all fallback auto-chain paths must remove disabled models and still filter model cooldowns."
);

assert(
  /preserveCooldownFailureLog\(/.test(bridge) &&
    /Recent router failures/.test(bridge) &&
    /model id/.test(bridge),
  "Bridge cooldown config sync must preserve the router failure log section and describe model-level cooldowns."
);

if (!process.exitCode) console.log("router cooldown logging ok");
