import type { DesktopUpdateStatus } from "./update-state.js";

export type PetMode = "sleeping" | "idle" | "listening" | "thinking" | "speaking" | "offline";

export type PetVisualState =
  | "idle"
  | "dragging"
  | "listening"
  | "thinking"
  | "approval"
  | "denied"
  | "approved"
  | "talking";

export type PetImagePools = Partial<Record<PetVisualState, string[]>>;

export type DesktopConfig = {
  backendUrl: string;
  startupEnabled: boolean;
  wakeEnabled: boolean;
  voiceEnabled: boolean;
  petMode: PetMode;
  bounds: WindowBounds | null;
};

export type WindowBounds = { x: number; y: number; width: number; height: number };

export type DesktopStatus = {
  backendUrl: string;
  bridgeOnline: boolean;
  runtimeOnline: boolean;
  startupEnabled: boolean;
  wakeEnabled: boolean;
  voiceEnabled: boolean;
  petMode: PetMode;
};

export type VoiceTurnResult = {
  transcript?: string;
  reply: string;
  model?: string;
  actions?: unknown[];
  timings?: {
    sttMs: number;
    agentMs: number;
    totalMs: number;
  };
  error?: string;
};

export type AudioTurnInput = {
  bytes: ArrayBuffer;
  type: string;
};

export type DesktopLocalActionIntent = {
  local_action: "open" | "open_app" | "whatsapp_send" | "shutdown" | "run_shell";
  target?: string;
  label: string;
  fallback?: string;
  only?: "app" | "folder";
  command?: string;
  autoSend?: boolean;
  delaySec?: number;
  cancel?: boolean;
};

export type DesktopActionResult = {
  ok: boolean;
  message: string;
  output?: string;
};

export type DesktopLaunchResult =
  | { ok: true }
  | { ok: false; error: string };

export type JarvisDesktopApi = {
  getStatus(): Promise<DesktopStatus>;
  getPetImages(): Promise<PetImagePools>;
  onPetImagesChanged(listener: (images: PetImagePools) => void): () => void;
  saveConfig(patch: Partial<DesktopConfig>): Promise<DesktopConfig>;
  runTextTurn(text: string): Promise<VoiceTurnResult>;
  runAudioTurn(input: AudioTurnInput): Promise<VoiceTurnResult>;
  runLocalAction(intent: DesktopLocalActionIntent): Promise<DesktopActionResult>;
  setPetMode(mode: PetMode): Promise<DesktopConfig>;
  getWindowBounds(): Promise<WindowBounds>;
  setWindowBounds(bounds: WindowBounds): Promise<void>;
  setPromptDockOpen(open: boolean): Promise<void>;
  getModelUrl(name: string): Promise<string>;
  restartBridge(): Promise<DesktopStatus>;
  openFullJarvis(): Promise<DesktopLaunchResult>;
  getUpdateStatus(): Promise<DesktopUpdateStatus>;
  checkForUpdates(): Promise<DesktopUpdateStatus>;
  installUpdate(): Promise<boolean>;
  onUpdateStatus(listener: (status: DesktopUpdateStatus) => void): () => void;
};

export type { DesktopUpdateStatus };

declare global {
  interface Window {
    jarvisDesktop: JarvisDesktopApi;
  }
}

export {};
