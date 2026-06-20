"use client";

// Browser-side client for the local bridge (scripts/bridge/server.mjs).
//
// The bridge runs ON the user's laptop at http://127.0.0.1:7777. This web app
// (served over HTTPS from Vercel) talks to it directly from the browser, since
// the browser is the only part of the stack that lives on the user's machine.
// Requests to localhost are allowed from secure pages by browsers' "localhost
// is potentially trustworthy" rule.

import type { LocalActionIntent } from "./local";
import { relayConfigured, relayRun, type RelayRunResult } from "./relay-client";

// Send an action payload (the bridge's /run shape) to the laptop. Prefer the
// localhost bridge when we're co-located with it (desktop); if localhost is
// unreachable but a cloud relay is configured, enqueue via the relay instead
// (phone). Returns a uniform { httpOk, status, data } either way.
async function runViaBridge(body: Record<string, unknown>): Promise<RelayRunResult> {
  const token = getBridgeToken();
  if (token) {
    try {
      const res = await fetch(`${getBridgeUrl()}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return { httpOk: res.ok, status: res.status, data };
    } catch {
      // Localhost unreachable — fall through to the relay (e.g. on the phone).
    }
  }
  if (relayConfigured()) return relayRun(body);
  return {
    httpOk: false,
    status: 0,
    data: { error: "Couldn't reach the local bridge. Is it running on your laptop (npm run bridge)?" },
  };
}

// True when SOME transport to the laptop is available (localhost token or relay).
function bridgeReachable(): boolean {
  return !!getBridgeToken() || relayConfigured();
}

const URL_KEY = "bridge.url";
const TOKEN_KEY = "bridge.token";
const PROFILE_KEY = "bridge.userProfile";

const DEFAULT_URL = "http://127.0.0.1:7777";

export function getBridgeUrl(): string {
  if (typeof window === "undefined") return DEFAULT_URL;
  return localStorage.getItem(URL_KEY) || DEFAULT_URL;
}

export function getBridgeToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setBridgeConfig(url: string, token: string) {
  localStorage.setItem(URL_KEY, url.trim() || DEFAULT_URL);
  localStorage.setItem(TOKEN_KEY, token.trim());
}

// The user's Windows home directory (e.g. C:\Users\Liu), sent with voice
// requests so the agent writes correct run_shell paths instead of guessing.
export function getUserProfile(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(PROFILE_KEY) || "";
}

export function setUserProfile(p: string) {
  localStorage.setItem(PROFILE_KEY, p.trim());
}

// Flip developer mode (arbitrary shell) on the bridge. Returns the new state.
// Goes through the shared bridge transport (localhost on desktop, cloud relay on
// the phone) so the toggle works from either device.
export async function setDevMode(enabled: boolean): Promise<{ ok: boolean; shellEnabled?: boolean }> {
  const { httpOk, data } = await runViaBridge({ action: "set_dev_mode", enabled });
  if (!httpOk) return { ok: false };
  return { ok: true, shellEnabled: !!data?.shellEnabled };
}

// Make the laptop bridge launch itself at every login (a Startup-folder
// shortcut). Runs on the bridge itself — a browser can't write to the Startup
// folder. Goes through the shared transport so it works from localhost or the
// phone (relay). Requires the bridge to be reachable right now.
export async function installAutostart(): Promise<{ ok: boolean; message?: string; error?: string }> {
  const { httpOk, data } = await runViaBridge({ action: "install_autostart" });
  if (!httpOk) return { ok: false, error: data?.error || "Couldn't reach the bridge." };
  return { ok: true, message: data?.message || "Auto-start at login is on." };
}

// Restart the bridge so it re-reads .env.local (apply RELAY_SECRET / RELAY_URL
// edits without a manual relaunch). The bridge replies, then drops ~2s later as
// it relaunches; expect a brief offline window before it heartbeats again.
export async function restartBridge(): Promise<{ ok: boolean; message?: string; error?: string }> {
  const { httpOk, data } = await runViaBridge({ action: "restart_bridge" });
  if (!httpOk) return { ok: false, error: data?.error || "Couldn't reach the bridge." };
  return { ok: true, message: data?.message || "Restarting the bridge…" };
}

export type BridgeHealth = {
  ok: boolean;
  apps?: string[];
  shellEnabled?: boolean;
  home?: string; // the user's real home dir, reported by the bridge
};

// Quick reachability/health check. Never throws — returns ok:false on failure.
export async function bridgeHealth(): Promise<BridgeHealth> {
  try {
    const res = await fetch(`${getBridgeUrl()}/health`, {
      headers: { Authorization: `Bearer ${getBridgeToken()}` },
    });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return {
      ok: true,
      apps: data.apps,
      shellEnabled: !!data.shellEnabled,
      home: data.home || "",
    };
  } catch {
    return { ok: false };
  }
}

export type ShellResult = {
  ok: boolean;
  message: string;
  output?: string; // combined stdout/stderr to show in the UI
};

// Developer mode: forward a confirmed PowerShell command to the bridge and
// return its captured output. The bridge re-validates the command (it never
// trusts the client), so a refusal here means it hit the destructive/opaque
// gate or developer mode is off.
export async function runShell(command: string, cwd?: string): Promise<ShellResult> {
  if (!bridgeReachable()) {
    return { ok: false, message: "No bridge token or relay secret set. Open Bridge settings and paste them from your laptop." };
  }
  const { httpOk, status, data } = await runViaBridge({ action: "run_shell", command, ...(cwd ? { cwd } : {}) });
  // A non-zero exit (compile error, missing module, a server that ran past the
  // bridge's command timeout) comes back with stdout/stderr but no `error`
  // field. Surface that captured output so the model can actually debug it,
  // instead of collapsing it to a useless "Bridge error".
  const output = [data?.stdout, data?.stderr].filter(Boolean).join("\n").trim();
  if (!httpOk) {
    const reason = data?.error
      ? String(data.error)
      : output
      ? `Command failed${data?.exitCode != null ? ` (exit ${data.exitCode})` : ""}:\n${output}`
      : `Bridge error (${status}).`;
    return { ok: false, message: reason, output };
  }
  return {
    ok: true,
    message: output ? "Command finished." : "Command finished (no output).",
    output,
  };
}

// ── Browser automation (Phase 2) ───────────────────────────────────────────
// Drive the bridge's real, logged-in browser. snapshot/text are reads; act
// performs a click/type the user has confirmed. All return the bridge's JSON
// (with ok:false + error on failure, e.g. Playwright not installed).
async function bridgePost(body: Record<string, unknown>): Promise<any> {
  if (!bridgeReachable()) return { ok: false, error: "No bridge token or relay secret set." };
  const { httpOk, status, data } = await runViaBridge(body);
  if (!httpOk) return { ok: false, error: data?.error || `Bridge error (${status}).` };
  return data;
}

// Login state the bridge detects on the snapshotted page, so the UI can warn the
// user (and optionally auto-fill saved credentials into userRef/passRef).
export type LoginState = {
  needed: boolean; // page wants a login
  hasPassword: boolean; // a password field is present (auto-fillable)
  emailOnly: boolean; // email-first step: identifier field, no password yet
  ssoOnly: boolean; // only Google/Apple/etc — must be done by hand
  providers: string[]; // e.g. ["google", "apple"]
  userRef: number | null;
  passRef: number | null;
  submitRef: number | null;
};

export type PageSnapshot = {
  ok: boolean;
  url?: string;
  title?: string;
  tree?: string; // "[12] button \"Submit\"" lines, one per element
  count?: number;
  fromCache?: boolean;
  login?: LoginState;
  error?: string;
};
export type PageOpenResult = {
  ok: boolean;
  opened?: boolean;
  url?: string;
  title?: string;
  tree?: string;
  count?: number;
  login?: LoginState;
  snapshot?: PageSnapshot;
  snapshotError?: string;
  error?: string;
};
export function pageOpen(url: string): Promise<PageOpenResult> {
  return bridgePost({ action: "page_open", target: url });
}
export function pageSnapshot(url?: string): Promise<PageSnapshot> {
  return bridgePost({ action: "page_snapshot", ...(url ? { target: url } : {}) });
}

export type PageTextResult = {
  ok: boolean;
  url?: string;
  title?: string;
  content?: string;
  truncated?: boolean;
  error?: string;
};
export function pageText(url?: string): Promise<PageTextResult> {
  return bridgePost({ action: "page_text", ...(url ? { target: url } : {}) });
}

export type PageActResult = { ok: boolean; message?: string; error?: string; snapshot?: PageSnapshot };
export function pageAct(
  act: "click" | "type" | "select" | "check" | "back" | "enter",
  ref?: string | number,
  text?: string
): Promise<PageActResult> {
  return bridgePost({ action: "page_act", act, ...(ref != null ? { ref: String(ref) } : {}), ...(text != null ? { text } : {}) });
}
export type PageScrollResult = { ok: boolean; message?: string; error?: string; snapshot?: PageSnapshot };
export function pageScroll(direction: "down" | "up" = "down", amount?: number): Promise<PageScrollResult> {
  return bridgePost({
    action: "page_scroll",
    direction,
    ...(Number.isFinite(amount) ? { amount } : {}),
  });
}

// ── OpenRouter / provider status board ──────────────────────────────────────
// One provider key (one Google/OpenRouter account) and one model row as the
// bridge proxies them from freellmapi's admin APIs.
export type ProviderKey = {
  id: number;
  platform: string;
  label: string;
  maskedKey: string;
  status: string; // "active" | "exhausted" | "invalid" | "unknown" | …
  enabled: boolean;
  lastCheckedAt?: string | null;
};
export type ProviderModel = {
  id: number;
  platform: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  rpdLimit?: number | null;
  rpmLimit?: number | null;
  priority?: number | null;
  fallbackEnabled?: boolean;
  keyCount?: number;
  intelligenceRank?: number;
  contextWindow?: number;
  tpdLimit?: number | null;
  // Combined usage across ALL keys/accounts serving this model_id.
  tokensTotal?: number;
  tokensToday?: number;
  requestsTotal?: number;
  requestsToday?: number;
  usageKeys?: number; // how many distinct keys have served it
};

// Fetch every provider key + model from freellmapi (via the bridge). Used by the
// Pipeline panel's status board so the user sees all accounts and model availability.
export async function openrouterStatus(): Promise<{
  ok: boolean;
  keys?: ProviderKey[];
  models?: ProviderModel[];
  note?: string;
  error?: string;
}> {
  const token = getBridgeToken();
  if (!token) return { ok: false, error: "No bridge token set." };
  try {
    const res = await fetch(`${getBridgeUrl()}/openrouter/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return { ok: false, error: data.error || `Bridge error (${res.status}).` };
    return { ok: true, keys: data.keys || [], models: data.models || [], note: data.note };
  } catch {
    return { ok: false, error: "Couldn't reach the local bridge. Is it running (npm run bridge)?" };
  }
}

export type RunResult = { ok: boolean; message: string };

// Forward a confirmed intent to the bridge to actually launch the app.
export async function runLocalAction(
  intent: LocalActionIntent
): Promise<RunResult> {
  if (!bridgeReachable()) {
    return {
      ok: false,
      message:
        "No bridge token or relay secret set. Open Bridge settings and paste them from your laptop.",
    };
  }
  const { httpOk, status, data } = await runViaBridge({
    action: intent.local_action,
    target: intent.target,
    ...(intent.fallback ? { fallback: intent.fallback } : {}),
    ...(intent.only ? { only: intent.only } : {}),
    ...(intent.autoSend ? { autoSend: true } : {}),
    ...(intent.cancel ? { cancel: true } : {}),
    ...(intent.delaySec != null ? { delaySec: intent.delaySec } : {}),
    // So the bridge can fall back to opening a FOLDER by this name under the
    // user's configured default folder (e.g. "open internship orders"). On the
    // phone this may be empty; the bridge then uses its own home dir.
    ...(getUserProfile() ? { searchFolder: getUserProfile() } : {}),
  });
  if (!httpOk) {
    return { ok: false, message: data?.error || `Bridge error (${status}).` };
  }
  // WhatsApp: the bridge opened the chat with the message typed; it either
  // auto-pressed Enter or left it for the user to send.
  if (intent.local_action === "whatsapp_send") {
    return {
      ok: true,
      message: data.autoSend
        ? `Sending your ${intent.label} message…`
        : `Opened ${intent.label} with the message ready — press Enter to send.`,
    };
  }
  // Shutdown: report whether we cancelled or how long until the machine powers off.
  if (intent.local_action === "shutdown") {
    if (intent.cancel) return { ok: true, message: "Cancelled the shutdown." };
    const s = intent.delaySec ?? 0;
    return {
      ok: true,
      message:
        s > 0
          ? `Shutting down your computer in ${s} second${s === 1 ? "" : "s"}. Say "cancel the shutdown" to stop it.`
          : "Shutting down your computer now.",
    };
  }
  // The bridge tells us what it actually opened (app / folder / website).
  if (data.opened === "website") {
    return { ok: true, message: `${intent.label} isn't installed — opening it in your browser.` };
  }
  if (data.opened === "folder") {
    return { ok: true, message: `Opening the ${intent.label} folder.` };
  }
  return { ok: true, message: `Opening ${intent.label}.` };
}
