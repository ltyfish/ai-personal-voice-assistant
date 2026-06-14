import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p) => readFileSync(join(root, p), "utf8");
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  }
};

const voiceButton = read("components/VoiceButton.tsx");
const voiceRoute = read("app/api/voice/route.ts");
const agent = read("lib/agent.ts");
const localAgent = read("lib/local-agent.ts");
const ollamaContext = read("lib/ollama-context.ts");
const toolConfig = read("lib/tool-config.ts");
const tools = read("lib/tools.ts");

assert(
  voiceButton.includes("getEnabledLocalToolNames") &&
    /enabledTools:\s*getEnabledLocalToolNames\(\)/.test(voiceButton),
  "VoiceButton must send the current tool allow-list to cloud /api/voice requests."
);

assert(
  /enabledTools\s*=\s*Array\.isArray/.test(voiceRoute) &&
    /runAgent\(userText,\s*\{[^}]*enabledTools/s.test(voiceRoute),
  "/api/voice must parse enabledTools and pass it into runAgent."
);

assert(
  /const allow = Array\.isArray\(opts\?\.enabledTools\) \? new Set\(opts!\.enabledTools\) : null;\s*tools = allow \? CLOUD_TOOLS\.filter\(\(d\) => allow\.has\(d\.function\.name\)\) : CLOUD_TOOLS;/s.test(agent),
  "Cloud planTurn must send only enabled CLOUD_TOOLS when enabledTools is provided."
);

assert(
  !/activeTools\s*=\s*toolDefs/.test(agent) &&
    /activeTools\s*=\s*tools/.test(agent),
  "Cloud fallback widening must never expand beyond the already-enabled tool list."
);

assert(
  /const allow = new Set\(opts!\.enabledTools\);\s*tools = toolDefs\.filter\(\(d\) => allow\.has\(d\.function\.name\)\);/s.test(agent),
  "Local prepareTurn must send only enabled toolDefs when enabledTools is provided."
);

assert(
  /dispatchLocalTool\(name, args\)/s.test(localAgent) &&
    /if \(!new Set\(getEnabledLocalToolNames\(\)\)\.has\(name\)\)/s.test(localAgent),
  "Local dispatch must hard-block any tool not currently enabled."
);

assert(
  /const sum = await complete\([\s\S]*?\],\s*exhausted,\s*\[\],\s*summaryOrder,\s*200\s*\)/s.test(agent),
  "Final summary pass must call complete with [] tools, not reload every tool schema."
);

assert(
  /multiRound:\s*false/.test(agent),
  "Cloud tool loop must not run another full-schema model round after a tool batch just to summarize."
);

assert(
  /localContinuationPrompt\(/.test(localAgent) &&
    /MORE_TOOLS/.test(localAgent) &&
    /needToolRound/.test(localAgent) &&
    !/requestedActionBudget\(/.test(localAgent) &&
    !/countRequestedActions\(/.test(localAgent) &&
    !/shouldContinueWithTools\(/.test(localAgent) &&
    !/BROWSER_FOLLOWUP_RE/.test(localAgent) &&
    /const roundTools = shouldUseTools \? prep\.tools : \[\];/s.test(localAgent) &&
    /messages: roundTools\.length \? messages : actions\.length \? localContinuationPrompt\(text, actions\) : messages/s.test(localAgent),
  "Local tool loop must let the model decide whether more tools are needed via a no-tools checkpoint."
);

assert(
  /AVAILABLE TOOLS ARE ONLY/.test(ollamaContext) &&
    /tools not present in this request are disabled/i.test(ollamaContext),
  "Local behavior context must tell the model that unchecked tools are unavailable, not part of a full toolbox."
);

assert(
  existsSync(join(root, "app/api/agent/tool-schema/route.ts")) &&
    /writeToolSchema/.test(read("app/api/agent/tool-schema/route.ts")),
  "A tool-schema endpoint must let checkbox changes update Obsidian immediately."
);

assert(
  /tools:\s*\["browser_open",\s*"browser_snapshot",\s*"browser_scroll",\s*"browser_act",\s*"browser_read"\]/.test(toolConfig),
  "Browser tools group must include browser_scroll and browser_read so the AI can scroll and read page text when enabled."
);

assert(
  !/label:\s*"Read pages"/.test(toolConfig) && !/tools:\s*\["read_site"\]/.test(toolConfig),
  "Local computer tool picker must not show read_site as a separate Read pages group."
);

assert(
  /name:\s*"browser_scroll"/.test(tools) &&
    /name:\s*"browser_read"/.test(tools) &&
    /Read the human-readable text from the page currently open in the controlled browser/.test(tools) &&
    /takes NO ref and does not click anything/.test(tools),
  "browser_scroll and browser_read must be present in the tool schema handed to enabled local/browser turns."
);

if (!process.exitCode) console.log("tool toggle wiring ok");
