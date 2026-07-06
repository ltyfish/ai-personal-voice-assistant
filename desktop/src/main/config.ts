import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DesktopConfig, PetMode } from "../shared/types.js";

export const CLOUD_BACKEND_URL = "https://ai-personal-voice-assistant.vercel.app";

const DEFAULT_CONFIG: DesktopConfig = {
  backendUrl: process.env.JARVIS_BACKEND_URL || CLOUD_BACKEND_URL,
  startupEnabled: true,
  wakeEnabled: true,
  voiceEnabled: true,
  petMode: "idle",
  bounds: null,
};

function configPath() {
  return join(app.getPath("userData"), "jarvis-desktop-config.json");
}

function normalizeMode(value: unknown): PetMode {
  return value === "sleeping" ||
    value === "idle" ||
    value === "listening" ||
    value === "thinking" ||
    value === "speaking" ||
    value === "offline"
    ? value
    : "idle";
}

function normalizeBounds(value: unknown): DesktopConfig["bounds"] {
  if (!value || typeof value !== "object") return null;
  const bounds = value as DesktopConfig["bounds"];
  if (!bounds) return null;
  if (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height)
  ) {
    return bounds;
  }
  return null;
}

function normalizeBackendUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_CONFIG.backendUrl;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed === "http://127.0.0.1:3100" || trimmed === "http://localhost:3100") return CLOUD_BACKEND_URL;
  return trimmed;
}

export function loadConfig(): DesktopConfig {
  const path = configPath();
  if (!existsSync(path)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DesktopConfig>;
    const next = {
      ...DEFAULT_CONFIG,
      ...raw,
      backendUrl: normalizeBackendUrl(raw.backendUrl),
      petMode: normalizeMode(raw.petMode),
      bounds: normalizeBounds(raw.bounds),
    };
    if (raw.backendUrl !== next.backendUrl || raw.petMode !== next.petMode) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
    }
    return next;
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
