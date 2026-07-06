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
  voiceEnabled: boolean;
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

declare global {
  interface Window {
    jarvisDesktop: JarvisDesktopApi;
  }
}

export {};
