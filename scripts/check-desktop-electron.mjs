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
assert(rootPkg.scripts["desktop:update"]?.includes("scripts/update-desktop-local.ps1"), "root package must expose desktop:update");

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
const petImages = read("desktop/src/main/pet-images.ts");
const types = read("desktop/src/shared/types.ts");
const runtime = read("desktop/src/main/runtime.ts");
const bridge = read("desktop/src/main/bridge.ts");
const viteConfig = read("desktop/vite.config.ts");
const app = read("desktop/src/renderer/App.tsx");
const wake = read("desktop/src/renderer/wake.ts");
const voice = read("desktop/src/renderer/voice.ts");
const localUpdater = read("scripts/update-desktop-local.ps1");
const petEnvExample = read("jarvis-pet.env.example");

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
assert(/maxWords:\s*18/.test(main), "desktop typed turns should cap spoken reply size");
assert(/enabledTools:\s*desktopEnabledTools/.test(main), "desktop typed turns should send a lightweight tool allow-list");
assert(/warmVoiceBackend/.test(main) && /warm:\s*true/.test(main), "desktop should warm the voice backend on startup");
assert(/desktop:runTextTurn/.test(main), "main process must expose runTextTurn IPC");
assert(/desktop:runAudioTurn/.test(main), "main process must expose audio turns for wake-triggered commands");
assert(/desktop:runLocalAction/.test(main), "main process must expose confirmed local bridge actions");
assert(/desktop:getModelUrl/.test(main), "main process must expose packaged wake model URLs");
assert(/next-app[\\\\/]public[\\\\/]models/.test(main), "packaged wake models must load from bundled public/models");
assert(/startBridge/.test(bridge), "bridge module must export startBridge");
assert(/restartBridge/.test(bridge), "bridge module must export restartBridge");
assert(/status\s*===\s*401/.test(bridge), "bridge presence must treat auth-protected health as online");
assert(/scripts[\\\\/]bridge[\\\\/]server\.mjs/.test(bridge), "bridge manager must launch existing bridge server");
assert(/desktop:restartBridge/.test(main), "main process must expose restart bridge IPC");
assert(/desktop:getWindowBounds/.test(main), "main process must expose window bounds for manual orb dragging");
assert(/desktop:setWindowBounds/.test(main), "main process must expose window movement for manual orb dragging");
assert(/desktop:setPromptDockOpen/.test(main), "main process must resize the transparent pet when the prompt dock opens");
assert(/desktop:getPetImages/.test(main), "main process must expose runtime pet images");
assert(/desktop:petImagesChanged/.test(main), "main process must publish pet image changes");
assert(/watchFile/.test(main), "main process must watch runtime pet image configuration");
assert(/getPetImages/.test(preload), "preload must expose initial runtime pet images");
assert(/onPetImagesChanged/.test(preload), "preload must expose hot pet image updates");
assert(/JARVIS_PET_DRAGGING_IMAGE/.test(petImages), "pet image loader must support dragging");
assert(/JARVIS_PET_APPROVED_IMAGE/.test(petImages), "pet image loader must support approved actions");
assert(/speechSynthesis/.test(voice), "renderer must speak replies with speechSynthesis");
assert(/WakeWordEngine/.test(wake), "renderer must reuse existing WakeWordEngine");
assert(/setWindowForMode/.test(main), "main process must resize the pet when sleeping");
assert(/showPetWindow/.test(main) && /fallback show/.test(main), "main process must force-show pet window if ready-to-show stalls");
assert(/transparent:\s*true/.test(main), "desktop pet window must be transparent by default");
assert(/frame:\s*false/.test(main), "desktop pet window must be frameless by default");
assert(/alwaysOnTop:\s*true/.test(main), "desktop pet must behave like a floating companion");
assert(/setAlwaysOnTop\(true,\s*["']screen-saver["']\)/.test(main), "desktop pet must use a stronger topmost level for game overlays");
assert(/showInactive\(\)/.test(main), "desktop pet must not steal focus when reasserting visibility");
assert(!/petWindow\?\.hide\(\)/.test(main), "closing the desktop pet must quit instead of hiding to tray");
assert(/window-all-closed[\s\S]*app\.quit/.test(main), "closing the last desktop window must quit the app");
assert(/setPetMode\("sleeping"\)/.test(app), "renderer must expose sleep mode");
assert(/Sending\.\.\./.test(app), "renderer must show an explicit sending state");
assert(/className="prompt-dock"/.test(app), "renderer prompt must sit in a dock below the pet");
assert(/promptOpen/.test(app), "renderer prompt dock must be toggleable");
assert(/!sleeping && promptOpen/.test(app), "renderer prompt must only show after pressing the pet");
assert(/onPointerDown=\{handleOrbPointerDown\}/.test(app), "pet must start manual drag handling on pointer down");
assert(/setWindowBounds/.test(app), "renderer must move the desktop window while dragging the pet");
assert(/setPromptDockOpen/.test(app), "renderer must shrink the transparent pet window while the dock is hidden");
assert(/captureVoiceTurn/.test(app), "wake detection must capture and send a voice command");
assert(/runAudioTurn/.test(app), "renderer must send wake-triggered audio turns through IPC");
assert(/ensureRunning/.test(wake) && /ensureRunning/.test(app), "renderer must resume wake audio from a user gesture");
assert(/manualListen/.test(app) && /directMicStream/.test(app), "renderer must provide a direct manual listening fallback");
assert(/>\s*Listen\s*</.test(app), "renderer must expose a Listen button for manual voice capture");
assert(/pendingAction/.test(app), "renderer must show pending local action approvals");
assert(/runLocalAction/.test(app), "renderer must run confirmed local actions through IPC");
assert(/selectPetVisualState/.test(app), "renderer must select explicit pet visual states");
assert(/onPetImagesChanged/.test(app), "renderer must hot reload image overrides");
assert(/setDragging\(true\)/.test(app), "renderer must show a dragging image after movement begins");
assert(/setTransientState\("approved"\)/.test(app), "renderer must show approved while an action runs");
assert(/setTransientState\("denied"\)/.test(app), "renderer must show denied after rejecting an action");
assert(/onError=/.test(app), "renderer must fall back when an override image fails");
assert(/selectRandomPetImage/.test(app), "renderer must randomly select from image pools");
assert(/lastPetImagesRef/.test(app), "renderer must remember the previous image per state");
assert(/failedPetImagesRef/.test(app), "renderer must exclude failed remote images");
assert(/300_000/.test(app), "idle image pool must rotate every five minutes");
assert(/setInterval/.test(app), "renderer must schedule idle image rotation");
assert(/event\.key === "Enter" && !event\.shiftKey/.test(app), "plain Enter must submit desktop prompts");
assert(/event\.preventDefault\(\)/.test(app), "Enter submit must prevent textarea newline insertion");
assert(!/Starting local JARVIS/.test(app), "renderer must not claim cloud backend is local startup");
assert(/idlePet/.test(app) && /thinkingPet/.test(app) && /approvalPet/.test(app), "renderer must use character pet image states");
assert(/listeningPet/.test(app) && /deniedPet/.test(app) && /talkingPet/.test(app), "renderer must bundle activity and approval-result images");
assert(/className="pet-character"/.test(app), "renderer must render the character pet instead of an orb");
assert(/@keyframes pet-idle-float/.test(read("desktop/src/renderer/app.css")), "idle pet must have subtle float animation");
assert(/@keyframes thinking-scoot/.test(read("desktop/src/renderer/app.css")), "thinking pet must visibly move");
assert(/@keyframes talking-pulse/.test(read("desktop/src/renderer/app.css")), "talking pet must animate");
assert(/\.pet-character\s*\{[\s\S]*background:\s*transparent/.test(read("desktop/src/renderer/app.css")), "character pet must not draw a background");
assert(!/backendUrl \|\| "Starting JARVIS/.test(app), "desktop dock must not show backend/debug URL in the normal prompt");
assert(!/saveStatusPatch/.test(app), "desktop dock must not show settings toggles in the normal prompt");
assert(/Stop-Process -Force/.test(localUpdater), "local updater must stop the stale installed desktop app");
assert(/npm --prefix desktop run build/.test(localUpdater), "local updater must rebuild the desktop installer");
assert(!/\/D=\$InstallDir/.test(localUpdater), "local updater must not rely on NSIS /D path handling for space-containing install paths");
assert(/win-unpacked/.test(localUpdater) && /Copy-Item/.test(localUpdater), "local updater must copy the unpacked build into the launch directory");
assert(/CreateShortcut/.test(localUpdater), "local updater must refresh the Start Menu shortcut");
assert(/Start-Process -FilePath \$exePath/.test(localUpdater), "local updater must relaunch the updated desktop app");
for (const key of [
  "IDLE",
  "DRAGGING",
  "LISTENING",
  "THINKING",
  "APPROVAL",
  "DENIED",
  "APPROVED",
  "TALKING",
]) {
  assert(petEnvExample.includes(`JARVIS_PET_${key}_IMAGE=`), `pet env example must include ${key}`);
}
assert(
  /JARVIS_PET_IDLE_IMAGE=.*,.*/.test(petEnvExample),
  "pet env example must demonstrate comma-separated image pools",
);
assert(/jarvis-pet\.env/.test(gitignore), "user pet image environment file must be ignored");
assert(/jarvis-pet\.env\.example/.test(localUpdater), "updater must seed pet image configuration");
assert(/Test-Path \$installedPetEnv/.test(localUpdater), "updater must preserve existing pet image configuration");

console.log("Desktop Electron check passed.");
