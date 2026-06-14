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

const localAgent = read("lib/local-agent.ts");
const bridge = read("lib/bridge.ts");
const tools = read("lib/tools.ts");
const browser = read("scripts/bridge/browser.mjs");
const server = read("scripts/bridge/server.mjs");

assert(
  /pageOpen/.test(bridge) &&
    /action:\s*"page_open"/.test(bridge) &&
    /case "browser_open"[\s\S]*pageOpen\(url\)/.test(localAgent) &&
    !/case "browser_open"[\s\S]*pageSnapshot\(url\)/.test(localAgent),
  "browser_open must use page_open, not a second page_snapshot request."
);

assert(
  /function normalizeBrowserUrl/.test(localAgent) &&
    /markdownMatch/.test(localAgent) &&
    /https\?:\\\/\\\//.test(localAgent),
  "browser_open must sanitize malformed markdown/rendered URL strings before navigating."
);

assert(
  /attemptedBrowserOpenThisTurn/.test(localAgent) &&
    /browser_open" && attemptedBrowserOpenThisTurn/.test(localAgent) &&
    /args = \{ \.\.\.args, url: cleanUrl \}/.test(localAgent) &&
    /Use browser_snapshot/.test(localAgent),
  "local browser loop must reject repeat browser_open attempts in one turn and log normalized URLs."
);

assert(
  /body\.action === "page_open"/.test(server) &&
    /pageOpen\(String\(body\.target \|\| ""\)\)/.test(server),
  "bridge server must expose page_open separately from page_snapshot."
);

assert(
  /export function pageOpen/.test(browser) &&
    /opened:\s*true/.test(browser) &&
    /snapshotAllFrames/.test(browser) &&
    /tree:\s*renderTree/.test(browser),
  "bridge browser pageOpen must navigate and include the initial snapshot in the same result."
);

assert(
  /clickableSelector/.test(browser) &&
    /viewport/.test(browser) &&
    /frame/.test(browser) &&
    /frameIndex/.test(browser) &&
    /parentRef/.test(browser) &&
    /controlSelector/.test(browser) &&
    /data-testid/.test(browser) &&
    /tabindex/.test(browser),
  "browser snapshot must include better selector, viewport/frame, clickable-parent metadata, and broader interactive selectors."
);

assert(
  /case "browser_scroll"[\s\S]*pageScroll\(/.test(localAgent) &&
    /browserScrollsThisTurn/.test(localAgent) &&
    /browserScrollsThisTurn >= 2/.test(localAgent) &&
    /export function pageScroll/.test(bridge) &&
    /action:\s*"page_scroll"/.test(bridge) &&
    /body\.action === "page_scroll"/.test(server) &&
    /export function pageScroll/.test(browser),
  "browser_scroll must be a distinct capped tool/bridge action that scrolls and returns a fresh snapshot."
);

assert(
  /frames\(\)/.test(browser) &&
    /snapshotAllFrames/.test(browser) &&
    /localRef/.test(browser),
  "browser snapshot/action must support refs from iframes."
);

assert(
  /dispatchEvent/.test(browser) &&
    /scrollIntoViewIfNeeded/.test(browser) &&
    /toggleAssociatedControl/.test(browser),
  "browser_act must use scroll-into-view, label checkbox/radio toggling, and fallback click dispatch."
);

assert(
  /browserTaskNeedsSubstance/.test(localAgent) &&
    /weakBrowserDoneReply/.test(localAgent) &&
    /looksLikeBareBrowserToolNameReply/.test(localAgent) &&
    /looksLikeRawBrowserSnapshotReply/.test(localAgent) &&
    /Do not quote raw snapshot text/.test(localAgent),
  "local browser research turns must not fall back to bare Done/tool-name replies or quote raw snapshots."
);

assert(
  !/recoverTargetWithScroll/.test(browser) &&
    !/recoverAfterMissingTarget/.test(browser) &&
    !/recoveredAfterScrolls/.test(browser) &&
    /couldn't find element \$\{ref\}; call browser_scroll/.test(browser),
  "browser_act must not auto-scroll/retry missing targets; it should tell the model to call browser_scroll."
);

assert(
  /scrollBy\(\{ top: dy/.test(browser) &&
    /window\.innerHeight \* 0\.75/.test(browser) &&
    /25% overlap/.test(browser) &&
    /querySelectorAll\("iframe"\)/.test(browser) &&
    /mouse\.wheel/.test(browser),
  "browser_scroll must use an overlapped viewport step and perform real page/frame scrolling before re-snapshotting."
);

assert(
  /snapshotAfterAction/.test(browser) &&
    /message: `Clicked \$\{ref\}\.`[\s\S]*snapshot/.test(browser) &&
    /message: `Checked \$\{ref\}\.`[\s\S]*snapshot/.test(browser) &&
    /message: `Typed into \$\{ref\}\.`[\s\S]*snapshot/.test(browser) &&
    /message: `Selected in \$\{ref\}\.`[\s\S]*snapshot/.test(browser),
  "browser_act must return a fresh snapshot after successful click/check/type/select actions."
);

assert(
  /Every successful action returns a fresh snapshot/.test(tools),
  "browser_act schema must tell the model every successful action returns a snapshot."
);

assert(
  /count:\s*0/.test(browser) &&
    /Use browser_read/.test(browser),
  "empty snapshots must return an actionable error instead of a silent empty success."
);

assert(
  /returns the initial snapshot/.test(tools) &&
    /browser_scroll/.test(tools) &&
    /If a click\/type\/select\/check target is missing/.test(tools) &&
    /ref.*required/i.test(tools) &&
    /Every successful action returns a fresh snapshot/.test(tools) &&
    /Do not use browser_read just to verify/.test(tools),
  "tool descriptions must tell the model the correct browser_act/browser_scroll params and follow-up read/snapshot behavior."
);

assert(
  /browser_snapshot[\s\S]*It is NOT the page reader/.test(tools) &&
    /browser_read[\s\S]*takes NO ref and does not click anything/.test(tools) &&
    /Use it to answer or summarize what is on the current page/.test(tools) &&
    /course\/result lists/.test(tools),
  "browser tool schema must clearly distinguish snapshot refs from browser_read page text."
);

assert(
  /Use browser_snapshot to get clickable refs only/.test(read("lib/ollama-context.ts")) &&
    /Use browser_read to read the actual page text\/results\/prose/.test(read("lib/ollama-context.ts")),
  "local behavior prompt must explain browser_read vs browser_snapshot."
);

if (!process.exitCode) console.log("browser automation flow ok");
