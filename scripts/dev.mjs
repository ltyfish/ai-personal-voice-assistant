#!/usr/bin/env node
// Dev launcher: runs the Next dev server AND the local bridge together, so you
// only ever run `npm run dev`. Each child's output is prefixed; Ctrl+C stops
// both. The bridge must run in YOUR interactive terminal session (this one) to
// be able to launch GUI apps — which is exactly where this runs.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");

function run(label, cmd, args, color, primary = false, shell = false) {
  const child = spawn(cmd, args, { shell });
  const tag = `\x1b[${color}m[${label}]\x1b[0m `;
  // A missing binary (e.g. Ollama not installed / not on PATH) must not crash
  // the launcher — report it and carry on, unless it's the primary process.
  child.on("error", (err) => {
    process.stdout.write(tag + `failed to start: ${err.message}\n`);
    if (primary) shutdown();
  });
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const ln of lines) out.write(tag + ln + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    process.stdout.write(tag + `exited (${code})\n`);
    // Only the primary (the web server) takes the launcher down. The bridge can
    // exit on its own (e.g. another bridge already owns the port) without
    // killing the dev server.
    if (primary) shutdown();
  });
  return child;
}

let children = [];
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

children = [
  // Local AI backend is freellmapi (a separate app with its own dashboard/port).
  // Start it yourself, then set FREELLMAPI_URL + FREELLMAPI_KEY in the bridge env;
  // the bridge relays /local/chat to it. It's not launched here on purpose.
  run("bridge", process.execPath, [join(root, "scripts/bridge/server.mjs")], "36"), // cyan
  run("next", process.execPath, [nextBin, "dev"], "35", true), // magenta (primary)
];
