import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, session, shell } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopConfig, DesktopStatus, PetMode, VoiceTurnResult } from "./shared/types.js";
import { bridgeOnline, restartBridge, startBridge, stopBridge } from "./main/bridge.js";
import { CLOUD_BACKEND_URL, loadConfig, saveConfig } from "./main/config.js";
import { RUNTIME_URL, startRuntime, stopRuntime, waitForRuntime } from "./main/runtime.js";

let petWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtimeOnline = false;
let bridgeIsOnline = false;
let isQuitting = false;
let savingProgrammaticBounds = false;
const mainDir = dirname(fileURLToPath(import.meta.url));

app.disableHardwareAcceleration();

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

function logDesktop(message: string, error?: unknown) {
  try {
    const dir = app.getPath("userData");
    mkdirSync(dir, { recursive: true });
    const detail = error instanceof Error ? ` ${error.stack || error.message}` : error ? ` ${String(error)}` : "";
    appendFileSync(join(dir, "desktop.log"), `${new Date().toISOString()} ${message}${detail}\n`, "utf8");
  } catch {
    // Logging must never break startup.
  }
}

function rendererUrl() {
  if (!app.isPackaged) return "http://127.0.0.1:5188";
  return `file://${join(mainDir, "renderer/index.html")}`;
}

function status(): DesktopStatus {
  const cfg = loadConfig();
  return {
    backendUrl: cfg.backendUrl || CLOUD_BACKEND_URL,
    bridgeOnline: bridgeIsOnline,
    runtimeOnline,
    startupEnabled: cfg.startupEnabled,
    wakeEnabled: cfg.wakeEnabled,
    voiceEnabled: cfg.voiceEnabled,
    petMode: cfg.petMode,
  };
}

function shouldStartLocalRuntime(backendUrl: string) {
  return /^https?:\/\/(127\.0\.0\.1|localhost):3100\b/i.test(backendUrl);
}

function applyStartup(enabled: boolean) {
  app.setLoginItemSettings({
    openAtLogin: enabled && app.isPackaged,
    path: process.execPath,
  });
}

function saveWindowBounds() {
  if (savingProgrammaticBounds || !petWindow) return;
  saveConfig({ bounds: petWindow.getBounds() });
}

function setWindowForMode(mode: PetMode) {
  if (!petWindow) return;
  savingProgrammaticBounds = true;
  const [width, height] = mode === "sleeping" ? [112, 112] : [380, 440];
  petWindow.setMinimumSize(mode === "sleeping" ? 86 : 320, mode === "sleeping" ? 86 : 360);
  petWindow.setSize(width, height, true);
  petWindow.center();
  setTimeout(() => {
    savingProgrammaticBounds = false;
  }, 200);
}

function showPetWindow() {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (petWindow.isMinimized()) petWindow.restore();
  petWindow.show();
  petWindow.focus();
  petWindow.moveTop();
}

function createPetWindow() {
  const cfg = loadConfig();
  const transparentPet = process.env.JARVIS_TRANSPARENT_PET === "1";
  logDesktop("creating pet window");
  petWindow = new BrowserWindow({
    width: cfg.petMode === "sleeping" ? 112 : cfg.bounds?.width ?? 380,
    height: cfg.petMode === "sleeping" ? 112 : cfg.bounds?.height ?? 440,
    x: cfg.bounds?.x,
    y: cfg.bounds?.y,
    transparent: transparentPet,
    backgroundColor: transparentPet ? "#00000000" : "#08080a",
    frame: !transparentPet,
    alwaysOnTop: transparentPet,
    resizable: true,
    show: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: join(mainDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  logDesktop("pet window constructed");
  setWindowForMode(cfg.petMode);
  showPetWindow();
  logDesktop(`loading renderer ${rendererUrl()}`);
  petWindow.loadURL(rendererUrl()).catch((error) => {
    logDesktop("renderer load failed", error);
    showPetWindow();
  });
  logDesktop("renderer load requested");
  petWindow.once("ready-to-show", () => {
    logDesktop("pet window ready-to-show");
    setWindowForMode(cfg.petMode);
    showPetWindow();
  });
  petWindow.webContents.once("did-finish-load", () => {
    logDesktop("renderer did-finish-load");
    setWindowForMode(cfg.petMode);
    showPetWindow();
  });
  petWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    logDesktop(`renderer did-fail-load ${errorCode}: ${errorDescription}`);
    showPetWindow();
  });
  petWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    logDesktop(`renderer console level=${level} ${sourceId}:${line} ${message}`);
  });
  petWindow.webContents.on("render-process-gone", (_event, details) => {
    logDesktop(`renderer gone: ${details.reason}`);
  });
  setTimeout(() => {
    logDesktop("pet window fallback show");
    setWindowForMode(loadConfig().petMode);
    showPetWindow();
  }, 3500);
  setTimeout(() => {
    logDesktop("pet window late fallback show");
    showPetWindow();
  }, 12_000);
  petWindow.on("show", () => {
    logDesktop("pet window shown");
  });
  petWindow.on("moved", saveWindowBounds);
  petWindow.on("resized", saveWindowBounds);
  petWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      petWindow?.hide();
    }
  });
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("JARVIS Desktop");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Wake JARVIS",
        click: () => {
          saveConfig({ petMode: "idle" });
          setWindowForMode("idle");
          showPetWindow();
        },
      },
      {
        label: "Sleep",
        click: () => {
          saveConfig({ petMode: "sleeping" });
          setWindowForMode("sleeping");
        },
      },
      {
        label: "Open full JARVIS",
        click: () => shell.openExternal(loadConfig().backendUrl || CLOUD_BACKEND_URL),
      },
      {
        label: "Restart bridge",
        click: async () => {
          restartBridge();
          bridgeIsOnline = await bridgeOnline();
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

function configureSessionPermissions() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
}

ipcMain.handle("desktop:getStatus", () => status());
ipcMain.handle("desktop:saveConfig", (_event, patch: Partial<DesktopConfig>) => {
  const next = saveConfig(patch);
  if (typeof patch.startupEnabled === "boolean") applyStartup(patch.startupEnabled);
  if (patch.petMode) setWindowForMode(patch.petMode);
  return next;
});
ipcMain.handle("desktop:setPetMode", (_event, mode: PetMode) => {
  const next = saveConfig({ petMode: mode });
  setWindowForMode(mode);
  return next;
});
ipcMain.handle("desktop:openFullJarvis", () => shell.openExternal(loadConfig().backendUrl || CLOUD_BACKEND_URL));
ipcMain.handle("desktop:restartBridge", async () => {
  restartBridge();
  bridgeIsOnline = await bridgeOnline();
  return status();
});
ipcMain.handle("desktop:runTextTurn", async (_event, text: string): Promise<VoiceTurnResult> => {
  const trimmed = text.trim();
  if (!trimmed) return { reply: "I didn't catch that." };

  const backendUrl = loadConfig().backendUrl || CLOUD_BACKEND_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);
  try {
    logDesktop(`voice turn start backend=${backendUrl}`);
    const res = await fetch(`${backendUrl}/api/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        text: trimmed,
        bridgeAvailable: status().bridgeOnline,
        useSnapshot: false,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<VoiceTurnResult>;
    logDesktop(`voice turn response status=${res.status}`);
    if (!res.ok) return { reply: "", error: data.error || `JARVIS returned ${res.status}` };
    return {
      transcript: data.transcript || trimmed,
      reply: data.reply || "No reply.",
      model: data.model,
      actions: data.actions,
    };
  } catch (err) {
    const error = err instanceof Error && err.name === "AbortError"
      ? "JARVIS timed out after 75 seconds."
      : (err as Error).message || "Could not reach JARVIS.";
    logDesktop("voice turn failed", err);
    return { reply: "", error };
  } finally {
    clearTimeout(timeout);
  }
});

app.whenReady().then(async () => {
  logDesktop("app ready");
  configureSessionPermissions();
  const cfg = loadConfig();
  applyStartup(cfg.startupEnabled);
  createPetWindow();
  createTray();
  if (shouldStartLocalRuntime(cfg.backendUrl)) startRuntime();
  startBridge();
  Promise.all([shouldStartLocalRuntime(cfg.backendUrl) ? waitForRuntime(10_000) : Promise.resolve(false), bridgeOnline()])
    .then(([nextRuntimeOnline, nextBridgeOnline]) => {
      runtimeOnline = nextRuntimeOnline;
      bridgeIsOnline = nextBridgeOnline;
      logDesktop(`startup dependencies runtime=${runtimeOnline} bridge=${bridgeIsOnline}`);
    })
    .catch((error) => {
      logDesktop("startup dependency check failed", error);
    });
});

app.on("second-instance", () => {
  logDesktop("second instance requested");
  if (!petWindow) {
    createPetWindow();
    return;
  }
  showPetWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
  stopBridge();
  stopRuntime();
});

app.on("window-all-closed", () => {});
