import { existsSync, readFileSync } from "node:fs";

function read(path) {
  if (!existsSync(path)) throw new Error(`Missing file: ${path}`);
  return readFileSync(path, "utf8");
}

function json(path) {
  return JSON.parse(read(path));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const rootPkg = json("package.json");
assert(rootPkg.scripts["desktop:check"] === "node scripts/check-desktop-electron.mjs", "root package must expose desktop:check");
assert(rootPkg.scripts["desktop:dev"] === "npm --prefix desktop run dev", "root package must expose desktop:dev");
assert(rootPkg.scripts["desktop:build"] === "npm --prefix desktop run build", "root package must expose desktop:build");

const desktopPkg = json("desktop/package.json");
assert(desktopPkg.private === true, "desktop package must be private");
assert(desktopPkg.main === "dist/main.js", "Electron main must point to dist/main.js");
for (const dep of ["electron", "electron-builder", "vite", "@vitejs/plugin-react", "typescript"]) {
  assert(desktopPkg.devDependencies?.[dep], `desktop package must include ${dep}`);
}
assert(desktopPkg.scripts.dev.includes("vite"), "desktop dev script must start Vite");
assert(desktopPkg.scripts.build.includes("electron-builder"), "desktop build script must package with electron-builder");
assert(desktopPkg.build?.win?.target?.includes("nsis"), "desktop package must build a Windows NSIS installer");
assert(desktopPkg.build?.win?.signAndEditExecutable === false, "desktop package must skip local code-sign helper extraction");
assert(JSON.stringify(desktopPkg.build?.extraResources || []).includes("scripts/bridge"), "desktop package must include bridge resources");
assert(JSON.stringify(desktopPkg.build?.extraResources || []).includes(".next-build"), "desktop package must include Next build resources");
assert(JSON.stringify(desktopPkg.build?.extraResources || []).includes("standalone"), "desktop package must include Next standalone runtime resources");

const gitignore = read(".gitignore");
assert(/desktop\/dist\//.test(gitignore), ".gitignore must ignore desktop/dist/");
assert(/desktop\/release\//.test(gitignore), ".gitignore must ignore desktop/release/");

const main = read("desktop/src/main.ts");
const preload = read("desktop/src/preload.cts");
const config = read("desktop/src/main/config.ts");
const types = read("desktop/src/shared/types.ts");
const runtime = read("desktop/src/main/runtime.ts");
const bridge = read("desktop/src/main/bridge.ts");
const viteConfig = read("desktop/vite.config.ts");
const app = read("desktop/src/renderer/App.tsx");
const wake = read("desktop/src/renderer/wake.ts");
const voice = read("desktop/src/renderer/voice.ts");

assert(/contextIsolation:\s*true/.test(main), "BrowserWindow must enable contextIsolation");
assert(/nodeIntegration:\s*false/.test(main), "BrowserWindow must disable nodeIntegration");
assert(!/__dirname/.test(main + runtime + bridge), "desktop ESM sources must not use __dirname");
assert(/requestSingleInstanceLock/.test(main), "main process must prevent duplicate desktop app instances");
assert(/desktop\.log/.test(main), "main process must write a startup log for desktop debugging");
assert(/console-message/.test(main), "main process must log renderer console errors");
assert(/base:\s*["']\.\/["']/.test(viteConfig), "desktop renderer must use relative Vite assets for file:// packaging");
assert(/setPermissionRequestHandler/.test(main), "main process must request microphone permission for wake listener");
assert(
  main.lastIndexOf("configureSessionPermissions()") > main.indexOf("app.whenReady()"),
  "session permission handler must be configured after app.whenReady()"
);
assert(/contextBridge\.exposeInMainWorld\("jarvisDesktop"/.test(preload), "preload must expose jarvisDesktop API");
assert(/preload\.cjs/.test(main), "BrowserWindow must load CommonJS preload output");
assert(!/ipcRenderer\.send\(/.test(preload), "preload must use invoke-based IPC, not fire-and-forget send");
assert(/type PetMode/.test(types), "shared types must define PetMode");
assert(/loadConfig/.test(config) && /saveConfig/.test(config), "config module must load and save desktop preferences");
assert(/CLOUD_BACKEND_URL/.test(config), "desktop must default assistant turns to the cloud backend");
assert(/127\.0\.0\.1:3100/.test(config) && /CLOUD_BACKEND_URL/.test(config), "desktop config must migrate stale local backend defaults");
assert(/writeFileSync\(path/.test(config), "desktop config migration must persist stale backend cleanup");
assert(/startRuntime/.test(runtime), "runtime module must export startRuntime");
assert(/waitForRuntime/.test(runtime), "runtime module must wait for backend health");
assert(/server\.js/.test(runtime), "packaged runtime must launch Next standalone server.js");
assert(/shouldStartLocalRuntime/.test(main), "desktop must not start local Next runtime unless backend is local");
assert(/\/api\/voice/.test(main), "main process must send typed turns to /api/voice");
assert(/AbortController/.test(main), "voice turns must have a timeout so the UI cannot stay stuck sending");
assert(/useSnapshot:\s*false/.test(main), "desktop typed turns should avoid heavyweight snapshots by default");
assert(/desktop:runTextTurn/.test(main), "main process must expose runTextTurn IPC");
assert(/startBridge/.test(bridge), "bridge module must export startBridge");
assert(/restartBridge/.test(bridge), "bridge module must export restartBridge");
assert(/status\s*===\s*401/.test(bridge), "bridge presence must treat auth-protected health as online");
assert(/scripts[\\\\/]bridge[\\\\/]server\.mjs/.test(bridge), "bridge manager must launch existing bridge server");
assert(/desktop:restartBridge/.test(main), "main process must expose restart bridge IPC");
assert(/speechSynthesis/.test(voice), "renderer must speak replies with speechSynthesis");
assert(/WakeWordEngine/.test(wake), "renderer must reuse existing WakeWordEngine");
assert(/setWindowForMode/.test(main), "main process must resize the pet when sleeping");
assert(/showPetWindow/.test(main) && /fallback show/.test(main), "main process must force-show pet window if ready-to-show stalls");
assert(/setPetMode\("sleeping"\)/.test(app), "renderer must expose sleep mode");
assert(/Sending\.\.\./.test(app), "renderer must show an explicit sending state");
assert(!/Starting local JARVIS/.test(app), "renderer must not claim cloud backend is local startup");

console.log("Desktop Electron check passed.");
