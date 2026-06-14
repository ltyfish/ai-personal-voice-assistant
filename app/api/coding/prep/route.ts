import { NextRequest, NextResponse } from "next/server";
import { getProject, readProjectMemoryTail } from "@/lib/coding";
import { CODING_FILE_TOOLS, BROWSER_TOOL_DEFS, RUN_SHELL_TOOL_DEF } from "@/lib/tools";

export const runtime = "nodejs";
export const maxDuration = 30;

// The DONE sentinel the loop watches for (kept in sync with lib/coding-agent.ts).
const DONE_MARKER = "TASK_COMPLETE";

function codingSystemPrompt(p: {
  name: string;
  task: string;
  workdir: string;
  memoryTail: string;
}): string {
  const memory = p.memoryTail.trim();
  return [
    "You are a focused autonomous CODING agent working on one project on the user's own computer.",
    "You work on your OWN, in a loop: think, use a tool, see the result, and continue — WITHOUT asking the user for confirmation between steps. Keep going until the task is genuinely finished.",
    "",
    `Project: ${p.name}`,
    `Working folder (your sandbox — all file paths are relative to it): ${p.workdir}`,
    `Task:\n${p.task}`,
    "",
    "## Your tools",
    "- list_dir / read_file / write_file / edit_file — explore and change files in the working folder. Read a file before you edit it; prefer edit_file for small changes.",
    "- run_shell — run a PowerShell command (git, npm, python, build/test). It is sandboxed and BLOCKS destructive/opaque commands (delete, overwrite via redirection, registry, downloads); to create or change files use the file tools, not shell redirection. If a command is refused, adapt.",
    "  IMPORTANT: each command has a ~15s timeout and must EXIT on its own. Do NOT start long-running/blocking processes (e.g. `node server.js`, `npm start`, `npm run dev`, a dev server, or a watch) — they never return and will time out. To VERIFY code instead use non-blocking checks: `node --check file.js` for syntax, `npm test`, `npm run build`, or run a short script that exits. A timeout is NOT a sandbox restriction — it means the command didn't finish.",
    "- browser_open / browser_snapshot / browser_scroll / browser_act / browser_read — drive a real browser if you need to look something up or use a logged-in page.",
    "",
    "## How to work",
    "1. Start by exploring (list_dir / read_file) so you understand the current state — don't assume.",
    "2. Make changes in small steps; after a change, VERIFY it (read the file back, or run a build/test with run_shell).",
    "3. SELF-REVIEW before finishing: re-read what you changed and confirm the task's requirements are all met and nothing is broken.",
    "4. If something fails, diagnose and fix it yourself; only stop if you are truly blocked (e.g. a tool you don't have, or a login only the user can do) — say so clearly.",
    "5. Keep a brief running narration of WHAT you are doing and WHY in your normal message text, so the user can follow along.",
    "",
    `When — and only when — the whole task is complete and self-reviewed, reply with a short summary of what you did, and end your message with the exact token ${DONE_MARKER} on its own line. Do not write ${DONE_MARKER} until the work is actually done.`,
    memory ? `\n## Project memory (what has happened so far)\n${memory}` : "",
  ].join("\n");
}

// Hands the CLIENT everything it needs to run the autonomous coding loop against a
// LOCAL model: the coding system prompt + the tool list. The browser drives the
// bridge's Ollama and posts file-tool calls back to /api/coding/tool.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const id = String(body.id || "");
    const project = getProject(id);
    if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });

    const system = codingSystemPrompt({
      name: project.name,
      task: project.task,
      workdir: project.workdir,
      memoryTail: readProjectMemoryTail(id),
    });
    const tools = [
      ...CODING_FILE_TOOLS,
      ...(RUN_SHELL_TOOL_DEF ? [RUN_SHELL_TOOL_DEF] : []),
      ...BROWSER_TOOL_DEFS,
    ];
    return NextResponse.json({ system, tools, model: project.model, doneMarker: DONE_MARKER });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "prep failed" }, { status: 500 });
  }
}
