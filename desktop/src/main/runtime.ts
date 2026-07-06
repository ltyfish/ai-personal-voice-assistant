import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let runtimeProcess: ChildProcessWithoutNullStreams | null = null;
const moduleDir = dirname(fileURLToPath(import.meta.url));

export const RUNTIME_PORT = 3100;
export const RUNTIME_URL = `http://127.0.0.1:${RUNTIME_PORT}`;

function projectRoot() {
  if (!app.isPackaged) return join(moduleDir, "../../..");
  return join(process.resourcesPath, "next-app");
}

function commandForRuntime(root: string) {
  if (app.isPackaged) {
    return {
      command: process.execPath,
      args: [join(root, "server.js")],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "dev:web", "--", "-p", String(RUNTIME_PORT)],
    env: {},
  };
}

export function startRuntime() {
  if (runtimeProcess) return runtimeProcess;
  const root = projectRoot();
  if (!existsSync(root)) return null;
  const { command, args, env } = commandForRuntime(root);
  runtimeProcess = spawn(command, args, {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(RUNTIME_PORT),
      ...env,
    },
    windowsHide: true,
  });
  runtimeProcess.on("exit", () => {
    runtimeProcess = null;
  });
  return runtimeProcess;
}

export async function waitForRuntime(timeoutMs = 20_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${RUNTIME_URL}/api/health`, { cache: "no-store" });
      if (res.ok) return true;
    } catch {
      // Keep polling until the local Next server has booted.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export function stopRuntime() {
  runtimeProcess?.kill();
  runtimeProcess = null;
}
