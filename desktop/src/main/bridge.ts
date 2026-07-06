import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let bridgeProcess: ChildProcessWithoutNullStreams | null = null;
const moduleDir = dirname(fileURLToPath(import.meta.url));

function bridgeScript() {
  if (!app.isPackaged) return join(moduleDir, "../../../scripts/bridge/server.mjs");
  return join(process.resourcesPath, "scripts/bridge/server.mjs");
}

export function startBridge() {
  if (bridgeProcess) return bridgeProcess;
  const script = bridgeScript();
  if (!existsSync(script)) return null;
  bridgeProcess = spawn(process.execPath, [script], {
    cwd: dirname(script),
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  bridgeProcess.on("exit", () => {
    bridgeProcess = null;
  });
  return bridgeProcess;
}

export function stopBridge() {
  bridgeProcess?.kill();
  bridgeProcess = null;
}

export function restartBridge() {
  stopBridge();
  return startBridge();
}

export async function bridgeOnline(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:7777/health", { cache: "no-store" });
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}
