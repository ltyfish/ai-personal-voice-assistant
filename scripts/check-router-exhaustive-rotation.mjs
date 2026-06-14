import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const routerPath = path.join(root, "lib", "llm-router.ts");
const llmPath = path.join(root, "lib", "llm.ts");

const router = fs.readFileSync(routerPath, "utf8");
const llm = fs.readFileSync(llmPath, "utf8");

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exitCode = 1;
  }
}

assert(
  /orderBy\(sql`\$\{llmKeys\.lastUsedAt\} ASC NULLS FIRST`\)/.test(router),
  "candidateKeys must order LRU first with never-used keys first, not sticky MRU.",
);

assert(
  !/if\s*\(\s*budget\.attempts\s*<=\s*0\s*\)[\s\S]{0,120}routeOne/.test(router),
  "AUTO_CHAIN must not stop moving to the next model because a global retry budget was spent.",
);

const routeOneMatch = router.match(/async function routeOne[\s\S]*?\n}\n\nexport async function/);
const routeOne = routeOneMatch?.[0] ?? "";
assert(
  !/budget\.attempts\s*--/.test(routeOne) && !/retry budget spent/.test(routeOne),
  "routeOne must walk every candidate key for that model, not stop after maxRetries.",
);

assert(
  !/return directCompletion\(model, params\)/.test(llm),
  "cloud createCompletion must not fall back to a separate direct env-key path when router keys are unavailable.",
);

if (process.exitCode) process.exit(1);
console.log("Router exhaustive rotation checks OK.");
