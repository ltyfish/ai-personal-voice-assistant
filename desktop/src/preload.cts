import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  AudioTurnInput,
  DesktopConfig,
  DesktopLaunchResult,
  DesktopUpdateStatus,
  DesktopLocalActionIntent,
  JarvisDesktopApi,
  PetImagePools,
  PetMode,
  VoiceTurnResult,
  WindowBounds,
} from "./shared/types.js";

const api: JarvisDesktopApi = {
  getStatus: () => ipcRenderer.invoke("desktop:getStatus"),
  getPetImages: () => ipcRenderer.invoke("desktop:getPetImages"),
  onPetImagesChanged: (listener) => {
    const handler = (_event: IpcRendererEvent, images: PetImagePools) => listener(images);
    ipcRenderer.on("desktop:petImagesChanged", handler);
    return () => ipcRenderer.removeListener("desktop:petImagesChanged", handler);
  },
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
  openFullJarvis: (): Promise<DesktopLaunchResult> => ipcRenderer.invoke("desktop:openFullJarvis"),
  getUpdateStatus: () => ipcRenderer.invoke("desktop:getUpdateStatus"),
  checkForUpdates: () => ipcRenderer.invoke("desktop:checkForUpdates"),
  installUpdate: () => ipcRenderer.invoke("desktop:installUpdate"),
  onUpdateStatus: (listener: (status: DesktopUpdateStatus) => void) => {
    const handler = (_event: IpcRendererEvent, status: DesktopUpdateStatus) => listener(status);
    ipcRenderer.on("desktop:updateStatus", handler);
    return () => ipcRenderer.removeListener("desktop:updateStatus", handler);
  },
};

contextBridge.exposeInMainWorld("jarvisDesktop", api);
