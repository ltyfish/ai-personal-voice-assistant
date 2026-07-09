import { contextBridge, ipcRenderer } from "electron";
import type {
  AudioTurnInput,
  DesktopConfig,
  DesktopLocalActionIntent,
  JarvisDesktopApi,
  PetMode,
  VoiceTurnResult,
  WindowBounds,
} from "./shared/types.js";

const api: JarvisDesktopApi = {
  getStatus: () => ipcRenderer.invoke("desktop:getStatus"),
  saveConfig: (patch: Partial<DesktopConfig>) => ipcRenderer.invoke("desktop:saveConfig", patch),
  runTextTurn: (text: string): Promise<VoiceTurnResult> => ipcRenderer.invoke("desktop:runTextTurn", text),
  runAudioTurn: (input: AudioTurnInput): Promise<VoiceTurnResult> => ipcRenderer.invoke("desktop:runAudioTurn", input),
  runLocalAction: (intent: DesktopLocalActionIntent) => ipcRenderer.invoke("desktop:runLocalAction", intent),
  setPetMode: (mode: PetMode) => ipcRenderer.invoke("desktop:setPetMode", mode),
  getWindowBounds: () => ipcRenderer.invoke("desktop:getWindowBounds"),
  setWindowBounds: (bounds: WindowBounds) => ipcRenderer.invoke("desktop:setWindowBounds", bounds),
  setPromptDockOpen: (open: boolean) => ipcRenderer.invoke("desktop:setPromptDockOpen", open),
  getModelUrl: (name: string) => ipcRenderer.invoke("desktop:getModelUrl", name),
  restartBridge: () => ipcRenderer.invoke("desktop:restartBridge"),
  openFullJarvis: () => ipcRenderer.invoke("desktop:openFullJarvis"),
};

contextBridge.exposeInMainWorld("jarvisDesktop", api);
