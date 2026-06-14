// Pipeline-mode project store (LOCAL ONLY).
//
// A pipeline project runs a 3-team coding workflow on the user's machine:
//   Planning  → studies the codebase and writes a plan file (plan.md, plan-2.md…)
//   Execution → reads ONLY that plan + the original prompt and implements it
//   Review&Test (optional) → reads the prompt + plan + changed code, tests/reviews
//
// Each project is a folder on disk under the pipeline base dir, holding:
//   meta.json  — { id, name, slug, prompt, workdir, phase, iteration, createdAt, updatedAt }
//   memory.md  — rolling progress log the teams append to as they work.
// The plan files themselves live in the project's WORKING folder (workdir) so the
// codebase and its plan sit together; each new follow-up prompt writes a NEW plan
// file (never touching the previous one).
//
// Like coding mode this is filesystem state on the USER'S machine, so it only works
// when the Next server runs locally (npm run dev).

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Pipeline projects live in the Jarvis project-memory vault by default. Override
// with PIPELINE_DIR when you want them somewhere else.
const PIPELINE_BASE =
  process.env.PIPELINE_DIR || "C:\\Users\\User\\Downloads\\Projects\\Jarvis Personal AI";
const ROOT = join(PIPELINE_BASE, "pipeline");

const MEMORY_INJECT = 3500; // chars of memory.md fed back into a phase prompt

// idle → planning → awaiting_exec → executing → awaiting_review → reviewing → done
export type PipelinePhase =
  | "idle"
  | "planning"
  | "awaiting_exec"
  | "executing"
  | "awaiting_review"
  | "reviewing"
  | "done"
  | "error";

export type PipelineProject = {
  id: string;
  name: string;
  slug: string;
  prompt: string; // the CURRENT prompt driving this iteration
  workdir: string;
  phase: PipelinePhase;
  iteration: number; // 1-based; increments on each follow-up prompt
  // Checkpoints for the CURRENT iteration: which phases have genuinely finished.
  // A rerun resumes from the first un-done phase instead of redoing planning
  // (which would rewrite the plan and can derail work already executed). Both are
  // reset to false when a new follow-up prompt starts a fresh iteration.
  planDone?: boolean;
  execDone?: boolean;
  createdAt: string;
  updatedAt: string;
};

function ensureRoot() {
  if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true });
}

function slugify(name: string): string {
  const base =
    (name || "project")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project";
  ensureRoot();
  let slug = base;
  let n = 2;
  while (existsSync(join(ROOT, slug))) slug = `${base}-${n++}`;
  return slug;
}

const projDir = (slug: string) => join(ROOT, slug);
const metaPath = (slug: string) => join(projDir(slug), "meta.json");
const memoryPath = (slug: string) => join(projDir(slug), "memory.md");
// Per-phase report files, mirrored into the project's vault folder so each team's
// output is browsable in Obsidian. planning.md / execution.md / review.md.
const PHASE_DOC: Record<string, { file: string; title: string }> = {
  planning: { file: "planning.md", title: "Planning" },
  executing: { file: "execution.md", title: "Execution" },
  reviewing: { file: "review.md", title: "Review & Test" },
};
const phaseDocPath = (slug: string, phase: string) =>
  join(projDir(slug), PHASE_DOC[phase].file);

// Plan file for a given iteration, RELATIVE to the project workdir (so the file
// tools, which are workdir-scoped, can read/write it). Iteration 1 → plan.md.
export function planFileName(iteration: number): string {
  return iteration <= 1 ? "plan.md" : `plan-${iteration}.md`;
}

function readMeta(slug: string): PipelineProject | null {
  try {
    const m = JSON.parse(readFileSync(metaPath(slug), "utf8"));
    return m && m.id ? (m as PipelineProject) : null;
  } catch {
    return null;
  }
}

function writeMeta(p: PipelineProject) {
  ensureRoot();
  if (!existsSync(projDir(p.slug))) mkdirSync(projDir(p.slug), { recursive: true });
  writeFileSync(metaPath(p.slug), JSON.stringify(p, null, 2));
}

export function listProjects(): PipelineProject[] {
  ensureRoot();
  let slugs: string[] = [];
  try {
    slugs = readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return slugs
    .map((s) => readMeta(s))
    .filter((p): p is PipelineProject => !!p)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getProject(id: string): PipelineProject | null {
  return listProjects().find((p) => p.id === id) || null;
}

export function createProject(input: {
  name: string;
  prompt: string;
  workdir: string;
}): PipelineProject {
  const name = (input.name || "").trim() || "Untitled pipeline";
  const slug = slugify(name);
  const now = new Date().toISOString();
  // A working folder is optional; default to a workspace inside the project folder.
  let workdir = (input.workdir || "").trim();
  if (!workdir) {
    workdir = join(projDir(slug), "workspace");
    try { mkdirSync(workdir, { recursive: true }); } catch { /* best-effort */ }
  }
  const p: PipelineProject = {
    id: randomUUID(),
    name,
    slug,
    prompt: (input.prompt || "").trim(),
    workdir,
    phase: "idle",
    iteration: 1,
    planDone: false,
    execDone: false,
    createdAt: now,
    updatedAt: now,
  };
  writeMeta(p);
  if (!existsSync(memoryPath(slug))) {
    writeFileSync(
      memoryPath(slug),
      `# ${name} — pipeline memory\n\nWorking folder: ${p.workdir}\n\n## Progress log\n`
    );
  }
  return p;
}

export function updateProject(
  id: string,
  patch: Partial<Pick<PipelineProject, "name" | "prompt" | "workdir" | "phase" | "iteration" | "planDone" | "execDone">>
): PipelineProject | null {
  const p = getProject(id);
  if (!p) return null;
  const next: PipelineProject = { ...p, ...patch, updatedAt: new Date().toISOString() };
  writeMeta(next);
  return next;
}

export function deleteProject(id: string): boolean {
  const p = getProject(id);
  if (!p) return false;
  try {
    rmSync(projDir(p.slug), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function readProjectMemory(id: string): string {
  const p = getProject(id);
  if (!p) return "";
  try {
    return readFileSync(memoryPath(p.slug), "utf8");
  } catch {
    return "";
  }
}

export function readProjectMemoryTail(id: string): string {
  const all = readProjectMemory(id);
  return all.length > MEMORY_INJECT ? all.slice(all.length - MEMORY_INJECT) : all;
}

// Write a phase's report into the project's vault folder so Planning / Execution /
// Review & Test are each browsable as their own Markdown file in Obsidian. For
// planning we mirror the actual plan the team wrote (lives in the workdir); for
// execution/review we save the team's final summary, plus any outstanding errors.
// Best-effort: a sync failure must never break the pipeline run.
export function writePhaseDoc(id: string, phase: string, summary: string): boolean {
  const meta = PHASE_DOC[phase];
  if (!meta) return false;
  const p = getProject(id);
  if (!p) return false;
  let body = (summary || "").trim();
  try {
    if (phase === "planning") {
      const plan = readFileSync(join(p.workdir, planFileName(p.iteration)), "utf8");
      if (plan.trim()) body = plan.trim();
    } else if (phase === "executing") {
      try {
        const err = readFileSync(join(p.workdir, "error.md"), "utf8");
        if (err.trim()) body += `\n\n## Outstanding errors (error.md)\n${err.trim()}`;
      } catch { /* no error log — fine */ }
    }
  } catch { /* fall back to the summary */ }
  if (!body) body = "_(no output captured)_";
  const header =
    `# ${p.name} — ${meta.title}\n\n` +
    `_Iteration ${p.iteration} · updated ${new Date().toISOString()}_\n\n`;
  try {
    if (!existsSync(projDir(p.slug))) mkdirSync(projDir(p.slug), { recursive: true });
    writeFileSync(phaseDocPath(p.slug, phase), header + body + "\n");
    return true;
  } catch {
    return false;
  }
}

export function appendProjectMemory(id: string, entry: string): void {
  const p = getProject(id);
  if (!p || !entry.trim()) return;
  const stamp = new Date().toISOString();
  try {
    appendFileSync(memoryPath(p.slug), `\n### ${stamp}\n${entry.trim()}\n`);
  } catch {
    /* best-effort */
  }
}
