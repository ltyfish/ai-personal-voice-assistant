import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, session, shell } from "electron";
import type { Rectangle } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import type {
  AudioTurnInput,
  DesktopActionResult,
  DesktopConfig,
  DesktopLocalActionIntent,
  DesktopStatus,
  PetMode,
  VoiceTurnResult,
} from "./shared/types.js";
import { bridgeOnline, restartBridge, startBridge, stopBridge } from "./main/bridge.js";
import { CLOUD_BACKEND_URL, loadConfig, saveConfig } from "./main/config.js";
import { loadPetImages } from "./main/pet-images.js";
import { RUNTIME_URL, startRuntime, stopRuntime, waitForRuntime } from "./main/runtime.js";

let petWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtimeOnline = false;
let bridgeIsOnline = false;
let isQuitting = false;
let savingProgrammaticBounds = false;
let petImageWatchTimer: NodeJS.Timeout | undefined;
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

function petImagesEnvPath() {
  return app.isPackaged
    ? join(dirname(process.execPath), "jarvis-pet.env")
    : join(mainDir, "../../jarvis-pet.env");
}

function currentPetImages() {
  return loadPetImages(petImagesEnvPath());
}

function startPetImageWatcher() {
  const path = petImagesEnvPath();
  watchFile(path, { interval: 500 }, () => {
    clearTimeout(petImageWatchTimer);
    petImageWatchTimer = setTimeout(() => {
      if (!petWindow || petWindow.isDestroyed()) return;
      petWindow.webContents.send("desktop:petImagesChanged", currentPetImages());
    }, 150);
  });
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

function bundledModelPath(name: string) {
  const safeName = name.replace(/[^a-z0-9_.-]/gi, "");
  if (!app.isPackaged) return join(mainDir, "../../public/models", safeName);
  return join(process.resourcesPath, "next-app/public/models", safeName);
}

function bridgeTokenPath() {
  if (!app.isPackaged) return join(mainDir, "../../scripts/bridge/.bridge-token");
  return join(process.resourcesPath, "scripts/bridge/.bridge-token");
}

function readBridgeToken() {
  const path = bridgeTokenPath();
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trim();
}

function backendUrl() {
  return loadConfig().backendUrl || CLOUD_BACKEND_URL;
}

function desktopEnabledTools(text: string, bridgeAvailable: boolean) {
  const t = text.toLowerCase();
  const tools = new Set<string>();

  if (/\b(task|todo|subtask|complete|due)\b/.test(t)) {
    ["create_task", "update_task", "delete_task", "complete_all", "list_tasks", "add_subtask", "update_subtask", "delete_subtask", "list_subtasks"].forEach((tool) =>
      tools.add(tool),
    );
  }
  if (/\b(calendar|event|schedule|meeting|appointment)\b/.test(t)) {
    ["create_event", "update_event", "delete_event", "list_events"].forEach((tool) => tools.add(tool));
  }
  if (/\b(email|mail|inbox|message|contact|telegram|whatsapp|send)\b/.test(t)) {
    ["list_emails", "mark_emails_reviewed", "fetch_emails_now", "send_message", "list_contacts"].forEach((tool) => tools.add(tool));
  }
  if (/\b(note|remember|saved|search notes?)\b/.test(t)) {
    ["create_note", "search_notes", "update_note", "delete_note"].forEach((tool) => tools.add(tool));
  }
  if (bridgeAvailable && /\b(open|launch|folder|app|shutdown|restart|powershell|shell|command|run)\b/.test(t)) {
    ["open_app", "shutdown_computer", "run_shell"].forEach((tool) => tools.add(tool));
  }

  return [...tools];
}

function desktopAudioTools(bridgeAvailable: boolean) {
  const tools = [
    "list_tasks",
    "list_events",
    "list_emails",
    "search_notes",
    "send_message",
    "list_contacts",
  ];
  if (bridgeAvailable) tools.push("open_app", "shutdown_computer", "run_shell");
  return tools;
}

function appendDesktopTurnOptions(form: FormData, text = "") {
  form.set("bridgeAvailable", String(status().bridgeOnline));
  form.set("useSnapshot", "false");
  form.set("maxWords", "18");
  form.set("sttMode", "fast");
  form.set("enabledTools", JSON.stringify(text ? desktopEnabledTools(text, status().bridgeOnline) : desktopAudioTools(status().bridgeOnline)));
}

async function warmVoiceBackend() {
  try {
    await fetch(`${backendUrl()}/api/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ warm: true }),
    });
    logDesktop("voice backend warmed");
  } catch (error) {
    logDesktop("voice backend warm failed", error);
  }
}

async function postVoiceForm(form: FormData): Promise<VoiceTurnResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);
  try {
    const res = await fetch(`${backendUrl()}/api/voice`, {
      method: "POST",
      signal: controller.signal,
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as Partial<VoiceTurnResult>;
    if (!res.ok) return { reply: "", error: data.error || `JARVIS returned ${res.status}` };
    return {
      transcript: data.transcript || "",
      reply: data.reply || data.error || "No reply.",
      model: data.model,
      actions: data.actions,
      timings: data.timings,
      error: data.error,
    };
  } catch (err) {
    const error = err instanceof Error && err.name === "AbortError"
      ? "JARVIS timed out after 75 seconds."
      : (err as Error).message || "Could not reach JARVIS.";
    return { reply: "", error };
  } finally {
    clearTimeout(timeout);
  }
}

async function runBridgeAction(intent: DesktopLocalActionIntent): Promise<DesktopActionResult> {
  const token = readBridgeToken();
  if (!token) return { ok: false, message: "Bridge token is missing. Restart the bridge from the pet." };
  if (intent.local_action === "run_shell" && !intent.command) {
    return { ok: false, message: "No command was provided." };
  }
  const body = {
    action: intent.local_action,
    target: intent.target || intent.command || "",
    ...(intent.command ? { command: intent.command } : {}),
    ...(intent.fallback ? { fallback: intent.fallback } : {}),
    ...(intent.only ? { only: intent.only } : {}),
    ...(intent.autoSend ? { autoSend: true } : {}),
    ...(intent.cancel ? { cancel: true } : {}),
    ...(intent.delaySec != null ? { delaySec: intent.delaySec } : {}),
  };
  try {
    const res = await fetch("http://127.0.0.1:7777/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    const output = [data.stdout, data.stderr].filter(Boolean).join("\n").trim();
    if (!res.ok) return { ok: false, message: data.error || `Bridge error (${res.status}).`, output };
    if (intent.local_action === "run_shell") return { ok: true, message: output ? "Command finished." : "Command finished (no output).", output };
    if (intent.local_action === "shutdown") {
      if (intent.cancel) return { ok: true, message: "Cancelled the shutdown." };
      const seconds = intent.delaySec ?? 0;
      return { ok: true, message: seconds > 0 ? `Shutting down in ${seconds} seconds.` : "Shutting down now." };
    }
    if (intent.local_action === "whatsapp_send") {
      return { ok: true, message: data.autoSend ? `Sending your ${intent.label} message.` : `Opened ${intent.label} with the message ready.` };
    }
    if (data.opened === "folder") return { ok: true, message: `Opening the ${intent.label} folder.` };
    if (data.opened === "website") return { ok: true, message: `${intent.label} is not installed, opening the website.` };
    return { ok: true, message: `Opening ${intent.label}.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not reach the bridge." };
  }
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
  const [width, height] = mode === "sleeping" ? [250, 190] : [380, 440];
  petWindow.setMinimumSize(mode === "sleeping" ? 210 : 340, mode === "sleeping" ? 160 : 360);
  petWindow.setSize(width, height, true);
  petWindow.center();
  setTimeout(() => {
    savingProgrammaticBounds = false;
  }, 200);
}

function setPromptDockOpen(open: boolean) {
  if (!petWindow) return;
  savingProgrammaticBounds = true;
  const current = petWindow.getBounds();
  const [width, height] = open ? [380, 440] : [360, 300];
  const centerX = current.x + current.width / 2;
  petWindow.setMinimumSize(open ? 340 : 320, open ? 360 : 260);
  petWindow.setBounds({
    x: Math.round(centerX - width / 2),
    y: current.y,
    width,
    height,
  });
  setTimeout(() => {
    savingProgrammaticBounds = false;
  }, 200);
}

function showPetWindow() {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (petWindow.isMinimized()) petWindow.restore();
  petWindow.setAlwaysOnTop(true, "screen-saver");
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.showInactive();
  petWindow.moveTop();
}

function createPetWindow() {
  const cfg = loadConfig();
  logDesktop("creating pet window");
  petWindow = new BrowserWindow({
    width: cfg.petMode === "sleeping" ? 250 : cfg.bounds?.width ?? 380,
    height: cfg.petMode === "sleeping" ? 190 : cfg.bounds?.height ?? 440,
    x: cfg.bounds?.x,
    y: cfg.bounds?.y,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
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
  petWindow.setAlwaysOnTop(true, "screen-saver");
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
  petWindow.on("closed", () => {
    petWindow = null;
  });
  setInterval(() => {
    if (!petWindow || petWindow.isDestroyed()) return;
    petWindow.setAlwaysOnTop(true, "screen-saver");
    petWindow.moveTop();
  }, 5000).unref();
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

ipcMain.handle("desktop:getStatus", async () => {
  bridgeIsOnline = await bridgeOnline();
  return status();
});
ipcMain.handle("desktop:getPetImages", () => currentPetImages());
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
ipcMain.handle("desktop:getWindowBounds", () => petWindow?.getBounds() ?? { x: 0, y: 0, width: 340, height: 360 });
ipcMain.handle("desktop:setWindowBounds", (_event, bounds: Rectangle) => {
  if (!petWindow) return;
  petWindow.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  });
});
ipcMain.handle("desktop:setPromptDockOpen", (_event, open: boolean) => {
  setPromptDockOpen(open);
});
ipcMain.handle("desktop:getModelUrl", (_event, name: string) => {
  return pathToFileURL(bundledModelPath(name)).toString();
});
ipcMain.handle("desktop:openFullJarvis", () => shell.openExternal(loadConfig().backendUrl || CLOUD_BACKEND_URL));
ipcMain.handle("desktop:restartBridge", async () => {
  restartBridge();
  bridgeIsOnline = await bridgeOnline();
  return status();
});
ipcMain.handle("desktop:runLocalAction", (_event, intent: DesktopLocalActionIntent) => runBridgeAction(intent));
ipcMain.handle("desktop:runAudioTurn", async (_event, input: AudioTurnInput): Promise<VoiceTurnResult> => {
  const requestStartedAt = performance.now();
  const bytes = input.bytes instanceof ArrayBuffer ? input.bytes : new Uint8Array(input.bytes).buffer;
  const type = input.type || "audio/webm";
  const form = new FormData();
  bridgeIsOnline = await bridgeOnline();
  form.set("audio", new Blob([bytes], { type }), type.includes("wav") ? "desktop.wav" : "desktop.webm");
  appendDesktopTurnOptions(form);
  const result = await postVoiceForm(form);
  const requestMs = Math.round(performance.now() - requestStartedAt);
  const timings = result.timings;
  logDesktop(
    `voice timings requestMs=${requestMs} sttMs=${timings?.sttMs ?? "?"} agentMs=${timings?.agentMs ?? "?"} totalMs=${timings?.totalMs ?? "?"}`,
  );
  return result;
});
ipcMain.handle("desktop:runTextTurn", async (_event, text: string): Promise<VoiceTurnResult> => {
  const trimmed = text.trim();
  if (!trimmed) return { reply: "I didn't catch that." };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75_000);
  try {
    bridgeIsOnline = await bridgeOnline();
    logDesktop(`voice turn start backend=${backendUrl()}`);
    const res = await fetch(`${backendUrl()}/api/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        text: trimmed,
        bridgeAvailable: status().bridgeOnline,
        maxWords: 18,
        useSnapshot: false,
        enabledTools: desktopEnabledTools(trimmed, status().bridgeOnline),
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
      timings: data.timings,
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
  startPetImageWatcher();
  createTray();
  if (shouldStartLocalRuntime(cfg.backendUrl)) startRuntime();
  startBridge();
  setTimeout(() => void warmVoiceBackend(), 1500);
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
  clearTimeout(petImageWatchTimer);
  unwatchFile(petImagesEnvPath());
  stopBridge();
  stopRuntime();
});

app.on("window-all-closed", () => {
  app.quit();
});
