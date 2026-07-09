import { app } from "electron";
import { autoUpdater } from "electron-updater";
import {
  initialUpdateStatus,
  reduceUpdateEvent,
  type DesktopUpdateEvent,
  type DesktopUpdateStatus,
} from "../shared/update-state.js";

let updateStatus: DesktopUpdateStatus = initialUpdateStatus;
let publishStatus: ((status: DesktopUpdateStatus) => void) | null = null;
let initialTimer: NodeJS.Timeout | undefined;
let periodicTimer: NodeJS.Timeout | undefined;
let configured = false;

function update(event: DesktopUpdateEvent) {
  updateStatus = reduceUpdateEvent(updateStatus, event);
  publishStatus?.(updateStatus);
}

function configure() {
  if (configured || !app.isPackaged) return;
  configured = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("checking-for-update", () => update({ type: "checking" }));
  autoUpdater.on("update-available", (info) => update({ type: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => update({ type: "current" }));
  autoUpdater.on("download-progress", (progress) => update({ type: "progress", percent: progress.percent }));
  autoUpdater.on("update-downloaded", (info) => update({ type: "downloaded", version: info.version }));
  autoUpdater.on("error", (error) => update({ type: "error", message: error.message || "Update failed." }));
}

export function getUpdateStatus() {
  return updateStatus;
}

export async function checkForUpdates() {
  if (!app.isPackaged) return updateStatus;
  configure();
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    update({
      type: "error",
      message: error instanceof Error ? error.message : "Update check failed.",
    });
  }
  return updateStatus;
}

export function installUpdate() {
  if (!app.isPackaged || updateStatus.state !== "ready") return false;
  autoUpdater.quitAndInstall(false, true);
  return true;
}

export function startUpdater(onStatus: (status: DesktopUpdateStatus) => void) {
  publishStatus = onStatus;
  if (!app.isPackaged) return;
  configure();
  initialTimer = setTimeout(() => void checkForUpdates(), 10_000);
  periodicTimer = setInterval(() => void checkForUpdates(), 6 * 60 * 60 * 1000);
  periodicTimer.unref();
}

export function stopUpdater() {
  clearTimeout(initialTimer);
  clearInterval(periodicTimer);
  publishStatus = null;
}
