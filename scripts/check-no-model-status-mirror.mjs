import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const server = readFileSync(join(root, "scripts/bridge/server.mjs"), "utf8");

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};

if (/Model Status\.md/.test(server)) {
  fail("bridge server must not reference or generate Model Status.md");
}

if (/\bsyncModelStatus\b/.test(server) || /\bMODEL_STATUS_FILE\b/.test(server)) {
  fail("bridge server must not run the old Model Status sync loop");
}

if (/localDisabled|LOCAL_DISABLED_FILE|saveLocalDisabled/.test(server)) {
  fail("bridge server must not enforce stale local model disables from the old Model Status mirror");
}

if (!process.exitCode) console.log("no model status mirror ok");
