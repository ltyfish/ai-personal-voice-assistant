import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, session, shell } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { bridgeOnline, restartBridge, startBridge, stopBridge } from "./main/bridge.js";
import { CLOUD_BACKEND_URL, loadConfig, saveConfig } from "./main/config.js";
import { startRuntime, stopRuntime, waitForRuntime } from "./main/runtime.js";
let petWindow = null;
let tray = null;
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
function logDesktop(message, error) {
    try {
        const dir = app.getPath("userData");
        mkdirSync(dir, { recursive: true });
        const detail = error instanceof Error ? ` ${error.stack || error.message}` : error ? ` ${String(error)}` : "";
        appendFileSync(join(dir, "desktop.log"), `${new Date().toISOString()} ${message}${detail}\n`, "utf8");
    }
    catch {
        // Logging must never break startup.
    }
}
function rendererUrl() {
    if (!app.isPackaged)
        return "http://127.0.0.1:5188";
    return `file://${join(mainDir, "renderer/index.html")}`;
}
function status() {
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
function shouldStartLocalRuntime(backendUrl) {
    return /^https?:\/\/(127\.0\.0\.1|localhost):3100\b/i.test(backendUrl);
}
function bundledModelPath(name) {
    const safeName = name.replace(/[^a-z0-9_.-]/gi, "");
    if (!app.isPackaged)
        return join(mainDir, "../../public/models", safeName);
    return join(process.resourcesPath, "next-app/public/models", safeName);
}
function bridgeTokenPath() {
    if (!app.isPackaged)
        return join(mainDir, "../../scripts/bridge/.bridge-token");
    return join(process.resourcesPath, "scripts/bridge/.bridge-token");
}
function readBridgeToken() {
    const path = bridgeTokenPath();
    if (!existsSync(path))
        return "";
    return readFileSync(path, "utf8").trim();
}
function backendUrl() {
    return loadConfig().backendUrl || CLOUD_BACKEND_URL;
}
async function postVoiceForm(form) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 75_000);
    try {
        const res = await fetch(`${backendUrl()}/api/voice`, {
            method: "POST",
            signal: controller.signal,
            body: form,
        });
        const data = (await res.json().catch(() => ({})));
        if (!res.ok)
            return { reply: "", error: data.error || `JARVIS returned ${res.status}` };
        return {
            transcript: data.transcript || "",
            reply: data.reply || data.error || "No reply.",
            model: data.model,
            actions: data.actions,
            error: data.error,
        };
    }
    catch (err) {
        const error = err instanceof Error && err.name === "AbortError"
            ? "JARVIS timed out after 75 seconds."
            : err.message || "Could not reach JARVIS.";
        return { reply: "", error };
    }
    finally {
        clearTimeout(timeout);
    }
}
async function runBridgeAction(intent) {
    const token = readBridgeToken();
    if (!token)
        return { ok: false, message: "Bridge token is missing. Restart the bridge from the pet." };
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
        if (!res.ok)
            return { ok: false, message: data.error || `Bridge error (${res.status}).`, output };
        if (intent.local_action === "run_shell")
            return { ok: true, message: output ? "Command finished." : "Command finished (no output).", output };
        if (intent.local_action === "shutdown") {
            if (intent.cancel)
                return { ok: true, message: "Cancelled the shutdown." };
            const seconds = intent.delaySec ?? 0;
            return { ok: true, message: seconds > 0 ? `Shutting down in ${seconds} seconds.` : "Shutting down now." };
        }
        if (intent.local_action === "whatsapp_send") {
            return { ok: true, message: data.autoSend ? `Sending your ${intent.label} message.` : `Opened ${intent.label} with the message ready.` };
        }
        if (data.opened === "folder")
            return { ok: true, message: `Opening the ${intent.label} folder.` };
        if (data.opened === "website")
            return { ok: true, message: `${intent.label} is not installed, opening the website.` };
        return { ok: true, message: `Opening ${intent.label}.` };
    }
    catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "Could not reach the bridge." };
    }
}
function applyStartup(enabled) {
    app.setLoginItemSettings({
        openAtLogin: enabled && app.isPackaged,
        path: process.execPath,
    });
}
function saveWindowBounds() {
    if (savingProgrammaticBounds || !petWindow)
        return;
    saveConfig({ bounds: petWindow.getBounds() });
}
function setWindowForMode(mode) {
    if (!petWindow)
        return;
    savingProgrammaticBounds = true;
    const [width, height] = mode === "sleeping" ? [112, 112] : [340, 360];
    petWindow.setMinimumSize(mode === "sleeping" ? 86 : 300, mode === "sleeping" ? 86 : 300);
    petWindow.setSize(width, height, true);
    petWindow.center();
    setTimeout(() => {
        savingProgrammaticBounds = false;
    }, 200);
}
function setPromptDockOpen(open) {
    if (!petWindow)
        return;
    savingProgrammaticBounds = true;
    const current = petWindow.getBounds();
    const [width, height] = open ? [340, 360] : [180, 180];
    const centerX = current.x + current.width / 2;
    petWindow.setMinimumSize(open ? 300 : 120, open ? 300 : 120);
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
    if (!petWindow || petWindow.isDestroyed())
        return;
    if (petWindow.isMinimized())
        petWindow.restore();
    petWindow.show();
    petWindow.focus();
    petWindow.moveTop();
}
function createPetWindow() {
    const cfg = loadConfig();
    logDesktop("creating pet window");
    petWindow = new BrowserWindow({
        width: cfg.petMode === "sleeping" ? 112 : cfg.bounds?.width ?? 340,
        height: cfg.petMode === "sleeping" ? 112 : cfg.bounds?.height ?? 360,
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
    tray.setContextMenu(Menu.buildFromTemplate([
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
    ]));
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
ipcMain.handle("desktop:saveConfig", (_event, patch) => {
    const next = saveConfig(patch);
    if (typeof patch.startupEnabled === "boolean")
        applyStartup(patch.startupEnabled);
    if (patch.petMode)
        setWindowForMode(patch.petMode);
    return next;
});
ipcMain.handle("desktop:setPetMode", (_event, mode) => {
    const next = saveConfig({ petMode: mode });
    setWindowForMode(mode);
    return next;
});
ipcMain.handle("desktop:getWindowBounds", () => petWindow?.getBounds() ?? { x: 0, y: 0, width: 340, height: 360 });
ipcMain.handle("desktop:setWindowBounds", (_event, bounds) => {
    if (!petWindow)
        return;
    petWindow.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
    });
});
ipcMain.handle("desktop:setPromptDockOpen", (_event, open) => {
    setPromptDockOpen(open);
});
ipcMain.handle("desktop:getModelUrl", (_event, name) => {
    return pathToFileURL(bundledModelPath(name)).toString();
});
ipcMain.handle("desktop:openFullJarvis", () => shell.openExternal(loadConfig().backendUrl || CLOUD_BACKEND_URL));
ipcMain.handle("desktop:restartBridge", async () => {
    restartBridge();
    bridgeIsOnline = await bridgeOnline();
    return status();
});
ipcMain.handle("desktop:runLocalAction", (_event, intent) => runBridgeAction(intent));
ipcMain.handle("desktop:runAudioTurn", async (_event, input) => {
    const bytes = input.bytes instanceof ArrayBuffer ? input.bytes : new Uint8Array(input.bytes).buffer;
    const type = input.type || "audio/webm";
    const form = new FormData();
    bridgeIsOnline = await bridgeOnline();
    form.set("audio", new Blob([bytes], { type }), type.includes("wav") ? "desktop.wav" : "desktop.webm");
    form.set("bridgeAvailable", String(status().bridgeOnline));
    form.set("useSnapshot", "false");
    return postVoiceForm(form);
});
ipcMain.handle("desktop:runTextTurn", async (_event, text) => {
    const trimmed = text.trim();
    if (!trimmed)
        return { reply: "I didn't catch that." };
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
                useSnapshot: false,
            }),
        });
        const data = (await res.json().catch(() => ({})));
        logDesktop(`voice turn response status=${res.status}`);
        if (!res.ok)
            return { reply: "", error: data.error || `JARVIS returned ${res.status}` };
        return {
            transcript: data.transcript || trimmed,
            reply: data.reply || "No reply.",
            model: data.model,
            actions: data.actions,
        };
    }
    catch (err) {
        const error = err instanceof Error && err.name === "AbortError"
            ? "JARVIS timed out after 75 seconds."
            : err.message || "Could not reach JARVIS.";
        logDesktop("voice turn failed", err);
        return { reply: "", error };
    }
    finally {
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
    if (shouldStartLocalRuntime(cfg.backendUrl))
        startRuntime();
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
app.on("window-all-closed", () => { });
//# sourceMappingURL=main.js.map