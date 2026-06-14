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

const feedLib = read("lib/router-feed.ts");
const route = read("app/api/router-feed/route.ts");
const hud = read("components/ModelHud.tsx");
const feed = read("components/RouterFeed.tsx");

assert(
  /clearRouterEvents/.test(feedLib) && /store\.buf\.length\s*=\s*0/.test(feedLib),
  "router-feed store must expose a server-side clear that empties the ring buffer."
);

assert(
  /export async function DELETE/.test(route) && /clearRouterEvents/.test(route),
  "/api/router-feed must support DELETE to clear the shared live log."
);

assert(
  /clearFeed/.test(hud) && /fetch\(`\/api\/router-feed`,\s*\{\s*method:\s*"DELETE"/s.test(hud),
  "ModelHud clear button must call DELETE /api/router-feed, not only clear local state."
);

assert(
  /clearFeed/.test(feed) && /fetch\(`\/api\/router-feed`,\s*\{\s*method:\s*"DELETE"/s.test(feed),
  "RouterFeed clear button must call DELETE /api/router-feed, not only clear local state."
);

if (!process.exitCode) console.log("router feed clear ok");
