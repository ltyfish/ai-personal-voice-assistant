# Windows JARVIS Desktop Pet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows Electron `.exe` copy of JARVIS with a draggable orb/pet, typed prompts, spoken replies, startup/tray controls, local bridge management, and the existing cloud/API/database/model-router path.

**Architecture:** Add a `desktop/` Electron app that manages a transparent pet window and, in packaged mode, launches a local Next runtime for the JARVIS backend/UI copy. The renderer calls the existing `/api/voice` JSON endpoint for typed prompts and reuses the existing browser wake-word engine for "Jarvis" detection. Data, model routing, MailMind, tasks, notes, and activity stay on the existing API/Neon path.

**Tech Stack:** Electron, electron-builder, TypeScript, React/Vite for the pet renderer, existing Next.js API routes, existing `lib/wakeword.ts`, existing browser `speechSynthesis`, existing `scripts/bridge/server.mjs`.

---

## Scope Check

This plan implements the first complete Windows desktop copy. It does not add a separate local database, macOS/Linux packaging, or a new model router. The plan intentionally keeps assistant turns on the existing `/api/voice` contract so the desktop app shares behavior with the current web app.

## File Structure

- Create `desktop/package.json`: desktop-only scripts and dependencies.
- Create `desktop/tsconfig.json`: TypeScript config for Electron main/preload/renderer code.
- Create `desktop/vite.config.ts`: renderer build config.
- Create `desktop/src/main.ts`: Electron main process, window, tray, IPC, startup setting.
- Create `desktop/src/preload.ts`: context-isolated IPC API exposed to renderer.
- Create `desktop/src/shared/types.ts`: shared IPC/data types.
- Create `desktop/src/main/config.ts`: local preferences load/save.
- Create `desktop/src/main/runtime.ts`: local Next runtime launcher and health wait.
- Create `desktop/src/main/bridge.ts`: local bridge process launcher and status.
- Create `desktop/src/renderer/index.html`: renderer entry HTML.
- Create `desktop/src/renderer/main.tsx`: React bootstrap.
- Create `desktop/src/renderer/App.tsx`: orb/prompt UI state machine.
- Create `desktop/src/renderer/app.css`: desktop pet styling.
- Create `desktop/src/renderer/voice.ts`: TTS helper.
- Create `desktop/src/renderer/wake.ts`: wrapper around existing `WakeWordEngine`.
- Create `scripts/check-desktop-electron.mjs`: static regression check for scripts, IPC safety, and required files.
- Modify `package.json`: add root scripts for desktop dev/build/check.
- Modify `.gitignore`: ignore desktop build outputs.

## Task 1: Desktop Package Scaffold

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/tsconfig.json`
- Create: `desktop/vite.config.ts`
- Create: `scripts/check-desktop-electron.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing scaffold check**

Create `scripts/check-desktop-electron.mjs`:

```js
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
assert(rootPkg.scripts["desktop:dev"], "root package must expose desktop:dev");
assert(rootPkg.scripts["desktop:build"], "root package must expose desktop:build");

const desktopPkg = json("desktop/package.json");
assert(desktopPkg.private === true, "desktop package must be private");
assert(desktopPkg.main === "dist/main/main.js", "Electron main must point to dist/main/main.js");
for (const dep of ["electron", "electron-builder", "vite", "@vitejs/plugin-react", "typescript"]) {
  assert(desktopPkg.devDependencies?.[dep], `desktop package must include ${dep}`);
}
assert(desktopPkg.scripts.dev.includes("vite"), "desktop dev script must start Vite");
assert(desktopPkg.scripts.build.includes("electron-builder"), "desktop build script must package with electron-builder");

const gitignore = read(".gitignore");
assert(/desktop\/dist\//.test(gitignore), ".gitignore must ignore desktop/dist/");
assert(/desktop\/release\//.test(gitignore), ".gitignore must ignore desktop/release/");

console.log("Desktop Electron scaffold check passed.");
```

- [ ] **Step 2: Run the check to verify it fails**

Run:

```powershell
node scripts/check-desktop-electron.mjs
```

Expected: failure mentioning `Missing file: desktop/package.json`.

- [ ] **Step 3: Add the desktop package files**

Create `desktop/package.json`:

```json
{
  "name": "jarvis-desktop",
  "version": "0.1.0",
  "private": true,
  "description": "Windows JARVIS desktop pet",
  "main": "dist/main/main.js",
  "scripts": {
    "dev": "concurrently -k \"vite --host 127.0.0.1 --port 5188\" \"wait-on http://127.0.0.1:5188 && electron .\"",
    "build:main": "tsc -p tsconfig.json",
    "build:renderer": "vite build",
    "build": "npm run build:main && npm run build:renderer && electron-builder --win nsis",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "build": {
    "appId": "ai.jarvis.desktop",
    "productName": "JARVIS Desktop",
    "directories": {
      "output": "release"
    },
    "files": [
      "dist/**/*",
      "package.json"
    ],
    "extraResources": [
      {
        "from": "../.next-build",
        "to": "next-app/.next-build",
        "filter": ["**/*"]
      },
      {
        "from": "../public",
        "to": "next-app/public",
        "filter": ["**/*"]
      },
      {
        "from": "../scripts/bridge",
        "to": "bridge",
        "filter": ["**/*"]
      }
    ],
    "win": {
      "target": ["nsis"]
    },
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true
    }
  },
  "dependencies": {},
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "concurrently": "^9.1.2",
    "electron": "^33.4.11",
    "electron-builder": "^25.1.8",
    "typescript": "^5.6.3",
    "vite": "^5.4.11",
    "wait-on": "^8.0.1"
  }
}
```

Create `desktop/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node", "electron"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

Create `desktop/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5188,
    strictPort: true,
  },
});
```

- [ ] **Step 4: Add root scripts and ignore outputs**

Modify root `package.json` scripts:

```json
{
  "desktop:check": "node scripts/check-desktop-electron.mjs",
  "desktop:dev": "npm --prefix desktop run dev",
  "desktop:build": "npm --prefix desktop run build"
}
```

Add these lines to `.gitignore`:

```gitignore
desktop/dist/
desktop/release/
```

- [ ] **Step 5: Install desktop dependencies**

Run:

```powershell
npm install --prefix desktop
```

Expected: `desktop/package-lock.json` is created and install exits 0.

- [ ] **Step 6: Verify scaffold passes**

Run:

```powershell
node scripts/check-desktop-electron.mjs
```

Expected: `Desktop Electron scaffold check passed.`

- [ ] **Step 7: Commit scaffold**

Run:

```powershell
git add package.json .gitignore scripts/check-desktop-electron.mjs desktop/package.json desktop/package-lock.json desktop/tsconfig.json desktop/vite.config.ts
git commit -m "feat: scaffold Windows JARVIS desktop app"
```

## Task 2: Main Process, Config, IPC

**Files:**
- Create: `desktop/src/shared/types.ts`
- Create: `desktop/src/main/config.ts`
- Create: `desktop/src/main.ts`
- Create: `desktop/src/preload.ts`
- Modify: `scripts/check-desktop-electron.mjs`

- [ ] **Step 1: Extend the failing check for Electron safety**

Append to `scripts/check-desktop-electron.mjs`:

```js
const main = read("desktop/src/main.ts");
const preload = read("desktop/src/preload.ts");
const config = read("desktop/src/main/config.ts");
const types = read("desktop/src/shared/types.ts");

assert(/contextIsolation:\s*true/.test(main), "BrowserWindow must enable contextIsolation");
assert(/nodeIntegration:\s*false/.test(main), "BrowserWindow must disable nodeIntegration");
assert(/contextBridge\.exposeInMainWorld\("jarvisDesktop"/.test(preload), "preload must expose jarvisDesktop API");
assert(!/ipcRenderer\.send\(/.test(preload), "preload must use invoke-based IPC, not fire-and-forget send");
assert(/type PetMode/.test(types), "shared types must define PetMode");
assert(/loadConfig/.test(config) && /saveConfig/.test(config), "config module must load and save desktop preferences");
```

- [ ] **Step 2: Run the check to verify it fails**

Run:

```powershell
node scripts/check-desktop-electron.mjs
```

Expected: failure mentioning `Missing file: desktop/src/main.ts`.

- [ ] **Step 3: Add shared types**

Create `desktop/src/shared/types.ts`:

```ts
export type PetMode = "sleeping" | "idle" | "listening" | "thinking" | "speaking" | "offline";

export type DesktopConfig = {
  backendUrl: string;
  startupEnabled: boolean;
  wakeEnabled: boolean;
  voiceEnabled: boolean;
  petMode: PetMode;
  bounds: { x: number; y: number; width: number; height: number } | null;
};

export type DesktopStatus = {
  backendUrl: string;
  bridgeOnline: boolean;
  runtimeOnline: boolean;
  startupEnabled: boolean;
  wakeEnabled: boolean;
  petMode: PetMode;
};

export type VoiceTurnResult = {
  transcript?: string;
  reply: string;
  model?: string;
  actions?: unknown[];
  error?: string;
};

export type JarvisDesktopApi = {
  getStatus(): Promise<DesktopStatus>;
  saveConfig(patch: Partial<DesktopConfig>): Promise<DesktopConfig>;
  runTextTurn(text: string): Promise<VoiceTurnResult>;
  setPetMode(mode: PetMode): Promise<DesktopConfig>;
  restartBridge(): Promise<DesktopStatus>;
  openFullJarvis(): Promise<void>;
};
```

- [ ] **Step 4: Add config storage**

Create `desktop/src/main/config.ts`:

```ts
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DesktopConfig, PetMode } from "../shared/types.js";

const DEFAULT_CONFIG: DesktopConfig = {
  backendUrl: "http://127.0.0.1:3100",
  startupEnabled: false,
  wakeEnabled: true,
  voiceEnabled: true,
  petMode: "idle",
  bounds: null,
};

function configPath() {
  return join(app.getPath("userData"), "jarvis-desktop-config.json");
}

function normalizeMode(value: unknown): PetMode {
  return value === "sleeping" || value === "listening" || value === "thinking" || value === "speaking" || value === "offline"
    ? value
    : "idle";
}

export function loadConfig(): DesktopConfig {
  const path = configPath();
  if (!existsSync(path)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DesktopConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      petMode: normalizeMode(raw.petMode),
      bounds: raw.bounds && Number.isFinite(raw.bounds.width) ? raw.bounds : null,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(patch: Partial<DesktopConfig>): DesktopConfig {
  const next = { ...loadConfig(), ...patch };
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
  return next;
}
```

- [ ] **Step 5: Add Electron main and preload**

Create `desktop/src/main.ts`:

```ts
import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, shell } from "electron";
import { join } from "node:path";
import type { DesktopStatus, PetMode } from "./shared/types.js";
import { loadConfig, saveConfig } from "./main/config.js";

let petWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

function rendererUrl() {
  if (!app.isPackaged) return "http://127.0.0.1:5188";
  return `file://${join(__dirname, "../renderer/index.html")}`;
}

function status(): DesktopStatus {
  const cfg = loadConfig();
  return {
    backendUrl: cfg.backendUrl,
    bridgeOnline: false,
    runtimeOnline: false,
    startupEnabled: cfg.startupEnabled,
    wakeEnabled: cfg.wakeEnabled,
    petMode: cfg.petMode,
  };
}

function createPetWindow() {
  const cfg = loadConfig();
  petWindow = new BrowserWindow({
    width: cfg.bounds?.width ?? 360,
    height: cfg.bounds?.height ?? 420,
    x: cfg.bounds?.x,
    y: cfg.bounds?.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  petWindow.loadURL(rendererUrl());
  petWindow.once("ready-to-show", () => petWindow?.show());
  petWindow.on("moved", () => {
    const bounds = petWindow?.getBounds();
    if (bounds) saveConfig({ bounds });
  });
  petWindow.on("resized", () => {
    const bounds = petWindow?.getBounds();
    if (bounds) saveConfig({ bounds });
  });
}

function setStartup(enabled: boolean) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
  });
  return saveConfig({ startupEnabled: enabled });
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("JARVIS Desktop");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Wake JARVIS", click: () => saveConfig({ petMode: "idle" }) },
    { label: "Sleep", click: () => saveConfig({ petMode: "sleeping" }) },
    { label: "Open full JARVIS", click: () => shell.openExternal(loadConfig().backendUrl) },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
}

ipcMain.handle("desktop:getStatus", () => status());
ipcMain.handle("desktop:saveConfig", (_event, patch) => {
  const next = saveConfig(patch);
  if (typeof patch?.startupEnabled === "boolean") setStartup(patch.startupEnabled);
  return next;
});
ipcMain.handle("desktop:setPetMode", (_event, mode: PetMode) => saveConfig({ petMode: mode }));
ipcMain.handle("desktop:openFullJarvis", () => shell.openExternal(loadConfig().backendUrl));

app.whenReady().then(() => {
  createPetWindow();
  createTray();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});
```

Create `desktop/src/preload.ts`:

```ts
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopConfig, JarvisDesktopApi, PetMode, VoiceTurnResult } from "./shared/types.js";

const api: JarvisDesktopApi = {
  getStatus: () => ipcRenderer.invoke("desktop:getStatus"),
  saveConfig: (patch: Partial<DesktopConfig>) => ipcRenderer.invoke("desktop:saveConfig", patch),
  runTextTurn: (text: string): Promise<VoiceTurnResult> => ipcRenderer.invoke("desktop:runTextTurn", text),
  setPetMode: (mode: PetMode) => ipcRenderer.invoke("desktop:setPetMode", mode),
  restartBridge: () => ipcRenderer.invoke("desktop:restartBridge"),
  openFullJarvis: () => ipcRenderer.invoke("desktop:openFullJarvis"),
};

contextBridge.exposeInMainWorld("jarvisDesktop", api);
```

- [ ] **Step 6: Verify safety check and typecheck**

Run:

```powershell
node scripts/check-desktop-electron.mjs
npm --prefix desktop run typecheck
```

Expected: check passes; TypeScript may fail because renderer files do not exist yet. If TypeScript fails only on missing renderer entry, continue to Task 3 before re-running typecheck.

- [ ] **Step 7: Commit main process**

Run:

```powershell
git add scripts/check-desktop-electron.mjs desktop/src/main.ts desktop/src/preload.ts desktop/src/main/config.ts desktop/src/shared/types.ts
git commit -m "feat: add desktop main process and IPC"
```

## Task 3: Pet Renderer Shell

**Files:**
- Create: `desktop/src/renderer/index.html`
- Create: `desktop/src/renderer/main.tsx`
- Create: `desktop/src/renderer/App.tsx`
- Create: `desktop/src/renderer/app.css`
- Modify: `desktop/src/shared/types.ts`

- [ ] **Step 1: Add renderer global type**

Append to `desktop/src/shared/types.ts`:

```ts
declare global {
  interface Window {
    jarvisDesktop: JarvisDesktopApi;
  }
}
```

- [ ] **Step 2: Create renderer entry files**

Create `desktop/src/renderer/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>JARVIS Desktop</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

Create `desktop/src/renderer/main.tsx`:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 3: Implement the pet UI**

Create `desktop/src/renderer/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { DesktopStatus, PetMode } from "../shared/types";

export default function App() {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [mode, setMode] = useState<PetMode>("idle");
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState("");

  useEffect(() => {
    window.jarvisDesktop.getStatus().then((next) => {
      setStatus(next);
      setMode(next.petMode);
    });
  }, []);

  async function setPetMode(next: PetMode) {
    const cfg = await window.jarvisDesktop.setPetMode(next);
    setMode(cfg.petMode);
  }

  async function submit() {
    const text = prompt.trim();
    if (!text) return;
    setMode("thinking");
    setReply("");
    const result = await window.jarvisDesktop.runTextTurn(text);
    setReply(result.reply || result.error || "No reply.");
    setMode(result.error ? "offline" : "speaking");
  }

  const sleeping = mode === "sleeping";

  return (
    <main className={`pet-shell mode-${mode}`}>
      <button className="orb" onClick={() => setPetMode(sleeping ? "idle" : "sleeping")} aria-label="Toggle JARVIS sleep">
        <span className="orb-core" />
        <span className="orb-ring" />
      </button>
      {!sleeping && (
        <section className="panel">
          <div className="header">
            <div>
              <strong>J.A.R.V.I.S.</strong>
              <span>{status?.backendUrl || "Starting..."}</span>
            </div>
            <button onClick={() => setPetMode("sleeping")}>Sleep</button>
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
            }}
            placeholder="Type a prompt..."
          />
          <div className="actions">
            <button onClick={submit} disabled={!prompt.trim() || mode === "thinking"}>Send</button>
            <button onClick={() => window.jarvisDesktop.openFullJarvis()}>Open full</button>
          </div>
          {reply && <p className="reply">{reply}</p>}
        </section>
      )}
    </main>
  );
}
```

- [ ] **Step 4: Add the pet styling**

Create `desktop/src/renderer/app.css`:

```css
html, body, #root {
  margin: 0;
  width: 100%;
  height: 100%;
  background: transparent;
  font-family: Inter, Segoe UI, system-ui, sans-serif;
  color: #f7f7f4;
  overflow: hidden;
}

.pet-shell {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  -webkit-app-region: drag;
}

.orb {
  position: relative;
  width: 132px;
  height: 132px;
  border: 0;
  border-radius: 999px;
  background: rgba(255,255,255,.04);
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.orb-core, .orb-ring {
  position: absolute;
  inset: 18px;
  border-radius: 999px;
  box-shadow: 0 0 38px rgba(255,255,255,.7), inset 0 0 22px rgba(255,255,255,.32);
}

.orb-ring {
  inset: 6px;
  border: 1px solid rgba(255,255,255,.65);
  animation: pulse 2.2s ease-in-out infinite;
}

.mode-thinking .orb-ring { animation-duration: .8s; }
.mode-speaking .orb-core { box-shadow: 0 0 54px rgba(255,255,255,.95), inset 0 0 28px rgba(255,255,255,.4); }
.mode-sleeping .orb { width: 76px; height: 76px; opacity: .58; }
.mode-sleeping .orb-core { inset: 24px; }
.mode-sleeping .orb-ring { display: none; }

.panel {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  border: 1px solid rgba(255,255,255,.16);
  border-radius: 10px;
  padding: 12px;
  background: rgba(5,5,6,.86);
  backdrop-filter: blur(18px);
  -webkit-app-region: no-drag;
}

.header, .actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.header span {
  display: block;
  max-width: 210px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(247,247,244,.58);
  font-size: 11px;
}

textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 78px;
  margin: 10px 0;
  resize: none;
  border: 1px solid rgba(255,255,255,.16);
  border-radius: 8px;
  padding: 10px;
  background: rgba(255,255,255,.06);
  color: #f7f7f4;
}

button {
  border: 1px solid rgba(255,255,255,.18);
  border-radius: 8px;
  padding: 7px 10px;
  background: rgba(255,255,255,.1);
  color: #f7f7f4;
}

button:disabled {
  opacity: .45;
}

.reply {
  margin: 10px 0 0;
  color: rgba(247,247,244,.78);
  font-size: 13px;
  line-height: 1.4;
}

@keyframes pulse {
  0%, 100% { transform: scale(.96); opacity: .72; }
  50% { transform: scale(1.04); opacity: 1; }
}
```

- [ ] **Step 5: Verify renderer builds**

Run:

```powershell
npm --prefix desktop run typecheck
npm --prefix desktop run build:renderer
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit renderer shell**

Run:

```powershell
git add desktop/src/renderer desktop/src/shared/types.ts
git commit -m "feat: add JARVIS desktop pet renderer"
```

## Task 4: Runtime and Assistant API Wiring

**Files:**
- Create: `desktop/src/main/runtime.ts`
- Modify: `desktop/src/main.ts`
- Modify: `scripts/check-desktop-electron.mjs`

- [ ] **Step 1: Extend the static check**

Append to `scripts/check-desktop-electron.mjs`:

```js
const runtime = read("desktop/src/main/runtime.ts");
assert(/startRuntime/.test(runtime), "runtime module must export startRuntime");
assert(/waitForRuntime/.test(runtime), "runtime module must wait for backend health");
assert(/\/api\/voice/.test(main), "main process must send typed turns to /api/voice");
assert(/desktop:runTextTurn/.test(main), "main process must expose runTextTurn IPC");
```

- [ ] **Step 2: Run check to verify it fails**

Run:

```powershell
node scripts/check-desktop-electron.mjs
```

Expected: failure mentioning `Missing file: desktop/src/main/runtime.ts`.

- [ ] **Step 3: Add runtime launcher**

Create `desktop/src/main/runtime.ts`:

```ts
import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

let runtimeProcess: ChildProcessWithoutNullStreams | null = null;

export const RUNTIME_PORT = 3100;
export const RUNTIME_URL = `http://127.0.0.1:${RUNTIME_PORT}`;

function projectRoot() {
  if (!app.isPackaged) return join(__dirname, "../../../..");
  return join(process.resourcesPath, "next-app");
}

export function startRuntime() {
  if (runtimeProcess) return runtimeProcess;
  const root = projectRoot();
  if (!existsSync(root)) return null;
  const command = app.isPackaged
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const args = app.isPackaged
    ? [join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(RUNTIME_PORT)]
    : ["run", "start", "--", "-p", String(RUNTIME_PORT)];
  runtimeProcess = spawn(command, args, {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(RUNTIME_PORT),
      ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
    windowsHide: true,
  });
  runtimeProcess.on("exit", () => {
    runtimeProcess = null;
  });
  return runtimeProcess;
}

export async function waitForRuntime(timeoutMs = 20_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${RUNTIME_URL}/api/health`, { cache: "no-store" });
      if (res.ok) return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return false;
}

export function stopRuntime() {
  runtimeProcess?.kill();
  runtimeProcess = null;
}
```

- [ ] **Step 4: Wire typed prompt IPC**

Modify `desktop/src/main.ts`:

```ts
import { startRuntime, waitForRuntime, RUNTIME_URL } from "./main/runtime.js";
```

In `status()`, set `runtimeOnline` from a module variable:

```ts
let runtimeOnline = false;

function status(): DesktopStatus {
  const cfg = loadConfig();
  return {
    backendUrl: cfg.backendUrl || RUNTIME_URL,
    bridgeOnline: false,
    runtimeOnline,
    startupEnabled: cfg.startupEnabled,
    wakeEnabled: cfg.wakeEnabled,
    petMode: cfg.petMode,
  };
}
```

Add IPC handler:

```ts
ipcMain.handle("desktop:runTextTurn", async (_event, text: string) => {
  const cfg = loadConfig();
  const backendUrl = cfg.backendUrl || RUNTIME_URL;
  try {
    const res = await fetch(`${backendUrl}/api/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        bridgeAvailable: status().bridgeOnline,
        useSnapshot: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { reply: "", error: data.error || `JARVIS returned ${res.status}` };
    return data;
  } catch (err) {
    return { reply: "", error: (err as Error).message || "Could not reach JARVIS." };
  }
});
```

In `app.whenReady()` before `createPetWindow()`:

```ts
startRuntime();
runtimeOnline = await waitForRuntime(8_000);
```

In `app.on("before-quit")`:

```ts
app.on("before-quit", () => {
  stopRuntime();
});
```

Also import `stopRuntime`.

- [ ] **Step 5: Verify typed wiring**

Run:

```powershell
node scripts/check-desktop-electron.mjs
npm --prefix desktop run typecheck
```

Expected: both exit 0.

- [ ] **Step 6: Commit runtime wiring**

Run:

```powershell
git add scripts/check-desktop-electron.mjs desktop/src/main/runtime.ts desktop/src/main.ts
git commit -m "feat: wire desktop app to JARVIS runtime"
```

## Task 5: TTS and Speaking State

**Files:**
- Create: `desktop/src/renderer/voice.ts`
- Modify: `desktop/src/renderer/App.tsx`

- [ ] **Step 1: Add TTS helper**

Create `desktop/src/renderer/voice.ts`:

```ts
export function speak(text: string, onEnd: () => void) {
  if (!("speechSynthesis" in window)) {
    onEnd();
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  utterance.onend = onEnd;
  utterance.onerror = onEnd;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
```

- [ ] **Step 2: Wire speaking into App**

Modify `desktop/src/renderer/App.tsx` imports:

```tsx
import { speak, stopSpeaking } from "./voice";
```

In `submit()`, after setting reply:

```tsx
const spoken = result.reply || result.error || "No reply.";
setReply(spoken);
setMode(result.error ? "offline" : "speaking");
if (!result.error) speak(spoken, () => setMode("idle"));
```

Add a Stop button in `.actions`:

```tsx
<button onClick={() => { stopSpeaking(); setMode("idle"); }}>Stop</button>
```

- [ ] **Step 3: Verify typecheck**

Run:

```powershell
npm --prefix desktop run typecheck
```

Expected: exit 0.

- [ ] **Step 4: Commit TTS**

Run:

```powershell
git add desktop/src/renderer/voice.ts desktop/src/renderer/App.tsx
git commit -m "feat: speak desktop JARVIS replies"
```

## Task 6: Bridge Manager and Tray Actions

**Files:**
- Create: `desktop/src/main/bridge.ts`
- Modify: `desktop/src/main.ts`
- Modify: `scripts/check-desktop-electron.mjs`

- [ ] **Step 1: Extend static check**

Append to `scripts/check-desktop-electron.mjs`:

```js
const bridge = read("desktop/src/main/bridge.ts");
assert(/startBridge/.test(bridge), "bridge module must export startBridge");
assert(/restartBridge/.test(bridge), "bridge module must export restartBridge");
assert(/scripts[\\\\/]bridge[\\\\/]server\.mjs/.test(bridge), "bridge manager must launch existing bridge server");
assert(/desktop:restartBridge/.test(main), "main process must expose restart bridge IPC");
```

- [ ] **Step 2: Run check to verify it fails**

Run:

```powershell
node scripts/check-desktop-electron.mjs
```

Expected: failure mentioning `Missing file: desktop/src/main/bridge.ts`.

- [ ] **Step 3: Add bridge manager**

Create `desktop/src/main/bridge.ts`:

```ts
import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

let bridgeProcess: ChildProcessWithoutNullStreams | null = null;

function bridgeScript() {
  if (!app.isPackaged) return join(__dirname, "../../../../scripts/bridge/server.mjs");
  return join(process.resourcesPath, "bridge/server.mjs");
}

export function startBridge() {
  if (bridgeProcess) return bridgeProcess;
  const script = bridgeScript();
  if (!existsSync(script)) return null;
  bridgeProcess = spawn(process.execPath, [script], {
    cwd: dirname(script),
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  bridgeProcess.on("exit", () => {
    bridgeProcess = null;
  });
  return bridgeProcess;
}

export function stopBridge() {
  bridgeProcess?.kill();
  bridgeProcess = null;
}

export function restartBridge() {
  stopBridge();
  return startBridge();
}

export async function bridgeOnline(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:7777/health", { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Wire bridge into main/tray**

Modify `desktop/src/main.ts` imports:

```ts
import { bridgeOnline, restartBridge, startBridge, stopBridge } from "./main/bridge.js";
```

Add module state:

```ts
let bridgeIsOnline = false;
```

In `status()`, return `bridgeOnline: bridgeIsOnline`.

Add IPC handler:

```ts
ipcMain.handle("desktop:restartBridge", async () => {
  restartBridge();
  bridgeIsOnline = await bridgeOnline();
  return status();
});
```

In tray menu add:

```ts
{ label: "Restart bridge", click: async () => { restartBridge(); bridgeIsOnline = await bridgeOnline(); } },
```

In `app.whenReady()` before `createPetWindow()`:

```ts
startBridge();
bridgeIsOnline = await bridgeOnline();
```

In `before-quit`:

```ts
stopBridge();
```

- [ ] **Step 5: Verify bridge wiring**

Run:

```powershell
node scripts/check-desktop-electron.mjs
npm --prefix desktop run typecheck
```

Expected: both exit 0.

- [ ] **Step 6: Commit bridge manager**

Run:

```powershell
git add scripts/check-desktop-electron.mjs desktop/src/main/bridge.ts desktop/src/main.ts
git commit -m "feat: manage local bridge from desktop app"
```

## Task 7: Wake Listener

**Files:**
- Create: `desktop/src/renderer/wake.ts`
- Modify: `desktop/src/renderer/App.tsx`
- Modify: `desktop/vite.config.ts`

- [ ] **Step 1: Make Vite resolve repo imports**

Modify `desktop/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, ".."),
    },
  },
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5188,
    strictPort: true,
  },
});
```

- [ ] **Step 2: Add wake wrapper**

Create `desktop/src/renderer/wake.ts`:

```ts
import type { WakeWordEngine } from "../../../lib/wakeword";

export type WakeHandle = {
  stop(): void;
};

export async function startWakeListener(onWake: () => void, onScore: (score: number) => void): Promise<WakeHandle> {
  const { WakeWordEngine } = await import("../../../lib/wakeword");
  const engine: WakeWordEngine = new WakeWordEngine({
    threshold: 0.5,
    onDetect: () => onWake(),
    onScore,
    onError: (msg) => console.warn("wake word error", msg),
  });
  await engine.start();
  return {
    stop() {
      engine.stop();
    },
  };
}
```

- [ ] **Step 3: Wire wake into App**

Modify `desktop/src/renderer/App.tsx` imports:

```tsx
import { startWakeListener, type WakeHandle } from "./wake";
```

Add state:

```tsx
const [wake, setWake] = useState<WakeHandle | null>(null);
const [wakeScore, setWakeScore] = useState(0);
```

Add effect:

```tsx
useEffect(() => {
  if (!status?.wakeEnabled || wake) return;
  startWakeListener(
    () => {
      setMode("listening");
      setReply("I heard Jarvis. Type or speak your command.");
    },
    setWakeScore,
  ).then(setWake).catch(() => setWake(null));
  return () => {
    wake?.stop();
  };
}, [status?.wakeEnabled, wake]);
```

Add wake score in header under backend URL:

```tsx
<span>Wake {wakeScore.toFixed(2)}</span>
```

- [ ] **Step 4: Verify wake build**

Run:

```powershell
npm --prefix desktop run typecheck
npm --prefix desktop run build:renderer
```

Expected: both exit 0. If Vite cannot bundle `onnxruntime-web`, add it to `desktop/package.json` dependencies with the same version as root and rerun `npm install --prefix desktop`.

- [ ] **Step 5: Commit wake listener**

Run:

```powershell
git add desktop/vite.config.ts desktop/src/renderer/wake.ts desktop/src/renderer/App.tsx desktop/package.json desktop/package-lock.json
git commit -m "feat: add desktop Jarvis wake listener"
```

## Task 8: Packaging Verification

**Files:**
- Modify: `scripts/check-desktop-electron.mjs`
- Modify: `desktop/package.json`

- [ ] **Step 1: Add packaging assertions**

Append to `scripts/check-desktop-electron.mjs`:

```js
assert(desktopPkg.build?.win?.target?.includes("nsis"), "desktop package must build a Windows NSIS installer");
assert(JSON.stringify(desktopPkg.build?.extraResources || []).includes("scripts/bridge"), "desktop package must include bridge resources");
assert(JSON.stringify(desktopPkg.build?.extraResources || []).includes(".next"), "desktop package must include Next build resources");
```

- [ ] **Step 2: Run full verification**

Run:

```powershell
node scripts/check-desktop-electron.mjs
npm --prefix desktop run typecheck
npm --prefix desktop run build:main
npm --prefix desktop run build:renderer
npm run build
npm --prefix desktop run build
```

Expected:

- static check passes.
- TypeScript passes.
- renderer builds.
- root Next build succeeds.
- Electron builder produces a Windows installer under `desktop/release/`.

- [ ] **Step 3: Manual Windows smoke test**

Run:

```powershell
npm run desktop:dev
```

Expected:

- A transparent JARVIS orb window appears.
- Dragging the window works.
- Typing a prompt and pressing Send returns a reply from existing `/api/voice`.
- Reply is spoken.
- Sleep shrinks the orb.
- Tray menu has Wake, Sleep, Open full JARVIS, Restart bridge, Quit.

- [ ] **Step 4: Commit packaging**

Run:

```powershell
git add scripts/check-desktop-electron.mjs desktop/package.json desktop/package-lock.json
git commit -m "build: package JARVIS desktop for Windows"
```

## Task 9: Project Memory Update

**Files:**
- Modify: `C:\Users\User\Downloads\PC_SYNC\Projects\Jarvis Personal AI\CHANGELOG.md`
- Modify: `C:\Users\User\Downloads\PC_SYNC\Projects\Jarvis Personal AI\HANDOFF.md`
- Modify: `C:\Users\User\Downloads\PC_SYNC\Projects\Jarvis Personal AI\PROJECT_MAP.md`

- [ ] **Step 1: Update `PROJECT_MAP.md`**

Add a short Desktop section:

```md
## Windows desktop app

- `desktop/` — Electron Windows JARVIS desktop pet. Main process owns tray/startup/window/bridge/runtime; renderer owns draggable orb, prompt panel, TTS, and wake listener.
- `scripts/check-desktop-electron.mjs` — static regression check for desktop package, IPC safety, and required files.
```

- [ ] **Step 2: Update `CHANGELOG.md`**

Add:

```md
## 2026-07-06 — Windows JARVIS desktop pet scaffold

- Added `desktop/` Electron app for Windows JARVIS pet: transparent draggable orb, prompt panel, TTS, wake-listener wrapper, runtime/bridge managers, tray/startup hooks.
- Desktop app uses existing JARVIS API/database/model-router path; website remains unchanged.
- Tests: `node scripts/check-desktop-electron.mjs`, `npm --prefix desktop run typecheck`, `npm --prefix desktop run build:main`, `npm --prefix desktop run build:renderer`, `npm run build`, `npm --prefix desktop run build`.
- Manual verification: document whether `npm run desktop:dev` showed orb, typed prompt reply, TTS, sleep, and tray actions.
```

- [ ] **Step 3: Update `HANDOFF.md`**

Add:

```md
## Recent (2026-07-06) — Windows JARVIS desktop pet
- Desktop app lives in `desktop/` and targets Windows Electron/NSIS. It manages the orb/prompt UI, tray/startup, local runtime, bridge, and wake listener while using the existing JARVIS API/database/model-router path.
- Current verification: list the exact passing commands and any manual gaps.
- Next: run installer on Windows login and verify startup/wake behavior after reboot.
```

- [ ] **Step 4: Commit memory updates**

Run:

```powershell
git add "C:\Users\User\Downloads\PC_SYNC\Projects\Jarvis Personal AI\PROJECT_MAP.md" "C:\Users\User\Downloads\PC_SYNC\Projects\Jarvis Personal AI\CHANGELOG.md" "C:\Users\User\Downloads\PC_SYNC\Projects\Jarvis Personal AI\HANDOFF.md"
git commit -m "docs: update memory for Windows desktop app"
```

If the vault is outside the Git repo, skip the `git add` for vault files and mention that memory files were updated outside repo tracking.

## Final Verification Checklist

- [ ] `node scripts/check-desktop-electron.mjs` passes.
- [ ] `npm --prefix desktop run typecheck` passes.
- [ ] `npm --prefix desktop run build:main` passes.
- [ ] `npm --prefix desktop run build:renderer` passes.
- [ ] `npm run build` passes.
- [ ] `npm --prefix desktop run build` creates a Windows installer.
- [ ] Manual `npm run desktop:dev` smoke test proves orb, typed prompt, TTS, sleep, tray, and bridge restart.
- [ ] Website behavior remains unchanged.
- [ ] No `.env` values or API keys are copied into renderer code.
