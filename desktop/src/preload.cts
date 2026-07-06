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
