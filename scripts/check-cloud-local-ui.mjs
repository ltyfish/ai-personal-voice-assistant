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

const abilitiesUi = read("components/Abilities.tsx");
const abilitiesRegistry = read("lib/abilities.ts");
const voiceButton = read("components/VoiceButton.tsx");
const localMode = read("lib/local-mode.ts");
const readPageCard = abilitiesUi
  .split(/\r?\n/)
  .find((line) => line.includes('label: "Read a page"')) || "";

assert(
  /where:\s*"cloud"/.test(readPageCard) && !/where:\s*"both"/.test(readPageCard),
  "Read a page must be tagged cloud-only in the Abilities UI."
);

assert(
  /cloud:\s*\{\s*text:\s*"Cloud only"/.test(abilitiesUi),
  "Cloud-only ability badges must say Cloud only."
);

assert(
  /id:\s*"open"[\s\S]*?group:\s*"search"/.test(abilitiesRegistry),
  "The read_site ability must use the search/cloud rule group, not local."
);

assert(
  !/MODE_LABELS/.test(voiceButton) &&
    !/\(\["cloud",\s*"local",\s*"hybrid"\]/.test(voiceButton) &&
    !/MODE_HELP\[localMode\]/.test(voiceButton),
  "The LOCAL AI panel must not render manual Cloud/Local/Hybrid mode buttons."
);

assert(
  /export type ModelMode = "local"/.test(localMode) &&
    !/"cloud" \| "local" \| "hybrid"/.test(localMode),
  "Voice mode must be local-only when the bridge is online; cloud is only the offline fallback route."
);

if (!process.exitCode) console.log("cloud/local UI wiring ok");
