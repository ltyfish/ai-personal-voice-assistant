// Pipeline-mode project store — CLOUD DB backed (mail_kv).
//
// A pipeline project runs a 3-team coding workflow on the user's machine:
//   Planning  → studies the codebase and writes a plan file (plan.md, plan-2.md…)
//   Execution → reads ONLY that plan + the original prompt and implements it
//   Review&Test (optional) → reads the prompt + plan + changed code, tests/reviews
//
// The PROJECT RECORD (prompt, workdir, phase, iteration, checkpoints) and the
// rolling memory log live in the cloud DB so they're reachable from BOTH the
// phone/cloud app and the laptop bridge — the bridge owns no inbound port, so a
// shared store is how the two sides agree on what to run. Previously this was
// local-disk state, which meant the pipeline only worked with a local Next
// server (npm run dev); moving it to the DB lets the phone drive a run that
// executes on the laptop bridge.
//
// The PLAN FILES themselves (plan.md / error.md) still live in the project's
// WORKING folder on the laptop's disk, written/read by the workdir-scoped file
// tools through the bridge — they sit next to the code they describe.
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { db, mailKv } from "@/db";

const NS_PROJ = "pipeline_proj"; // one row per project, key = id
const NS_MEM = "pipeline_mem"; // rolling memory log, key = id, value { text }
const NS_DOC = "pipeline_doc"; // per-phase report, key = `${id}:${phase}`

const MEMORY_INJECT = 3500; // chars of memory fed back into a phase prompt

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
  workdir: string; // a path on the LAPTOP (the bridge resolves/creates it)
  phase: PipelinePhase;
  iteration: number; // 1-based; increments on each follow-up prompt
  // Checkpoints for the CURRENT iteration: which phases have genuinely finished.
  // A rerun resumes from the first un-done phase instead of redoing planning.
  // Both reset to false when a new follow-up prompt starts a fresh iteration.
  planDone?: boolean;
  execDone?: boolean;
  createdAt: string;
  updatedAt: string;
};

// ── tiny mail_kv helpers ──────────────────────────────────────────────────────
async function kvGet<T>(ns: string, key: string): Promise<T | null> {
  const rows = await db
    .select({ value: mailKv.value })
    .from(mailKv)
    .where(and(eq(mailKv.namespace, ns), eq(mailKv.key, key)))
    .limit(1);
  return rows.length ? (rows[0].value as T) : null;
}

async function kvSet(ns: string, key: string, value: unknown) {
  await db
    .insert(mailKv)
    .values({ namespace: ns, key, value: value as object })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value: value as object, updatedAt: new Date() },
    });
}

async function kvDel(ns: string, key: string) {
  await db.delete(mailKv).where(and(eq(mailKv.namespace, ns), eq(mailKv.key, key)));
}

// Fallback working folder when a project has no explicit workdir. MUST match the
// bridge's fallback (scripts/bridge/pipeline.mjs) so the in-browser (local) and
// bridge execution paths build in the SAME place instead of disagreeing (the old
// behaviour: file tools failed locally, while the bridge silently used this dir).
// The path targets the LAPTOP, so we don't use node:path — the server may be
// POSIX while the laptop is Windows; we just append with the home dir's separator.
export function defaultWorkdir(id: string): string {
  const home = homedir();
  const sep = home.includes("\\") ? "\\" : "/";
  return [home.replace(/[\\/]+$/, ""), "JarvisPipelines", id].join(sep);
}

// Join a user-provided workspace ROOT with a project slug, preserving whatever
// separator the root already uses (so a Windows root stays Windows even if this
// code runs on a POSIX server). Used when a new project has no explicit workdir
// but the user has set a default workspace root.
function joinUnderRoot(root: string, slug: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return [root.replace(/[\\/]+$/, ""), slug].join(sep);
}

// Plan file for a given iteration, RELATIVE to the project workdir (so the file
// tools, which are workdir-scoped, can read/write it). Iteration 1 → plan.md.
// Pure (no I/O) — kept synchronous so callers don't need to await it.
export function planFileName(iteration: number): string {
  return iteration <= 1 ? "plan.md" : `plan-${iteration}.md`;
}

// A folder path pasted/picked by the user can arrive wrapped in literal quotes
// (e.g. Windows "Copy as path" yields `"C:\…\Pipeline Projects"`). Stored as-is,
// the quotes become part of the path and break mkdir + every run_shell cwd. Strip
// any surrounding single/double quotes whenever a workdir is persisted.
function cleanWorkdir(w: string | undefined): string {
  return String(w || "").trim().replace(/^['"]+|['"]+$/g, "").trim();
}

function slugify(name: string, taken: Set<string>): string {
  const base =
    (name || "project")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project";
  let slug = base;
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  return slug;
}

export async function listProjects(): Promise<PipelineProject[]> {
  const rows = await db
    .select({ value: mailKv.value })
    .from(mailKv)
    .where(eq(mailKv.namespace, NS_PROJ));
  return rows
    .map((r) => r.value as PipelineProject)
    .filter((p) => p && p.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProject(id: string): Promise<PipelineProject | null> {
  if (!id) return null;
  return kvGet<PipelineProject>(NS_PROJ, id);
}

export async function createProject(input: {
  name: string;
  prompt: string;
  workdir: string;
  // Optional default workspace ROOT (a folder under which each new pipeline gets
  // its own subfolder). Used only when `workdir` is left blank.
  workspaceRoot?: string;
}): Promise<PipelineProject> {
  const name = (input.name || "").trim() || "Untitled pipeline";
  const existing = await listProjects();
  const slug = slugify(name, new Set(existing.map((p) => p.slug)));
  const now = new Date().toISOString();
  // Resolve the working folder. Explicit workdir wins; otherwise, if the user set
  // a default root, give this project its own subfolder <root>/<slug>. If neither
  // is set, leave it blank — it resolves lazily to defaultWorkdir() at run time.
  let workdir = cleanWorkdir(input.workdir);
  if (!workdir) {
    const root = (input.workspaceRoot || "").trim();
    if (root) workdir = joinUnderRoot(root, slug);
  }
  const p: PipelineProject = {
    id: randomUUID(),
    name,
    slug,
    prompt: (input.prompt || "").trim(),
    // A path on the laptop. The bridge creates/resolves it on first use; an empty
    // value means "let the bridge pick a default workspace" (defaultWorkdir()).
    workdir,
    phase: "idle",
    iteration: 1,
    planDone: false,
    execDone: false,
    createdAt: now,
    updatedAt: now,
  };
  await kvSet(NS_PROJ, p.id, p);
  await kvSet(NS_MEM, p.id, {
    text: `# ${name} — pipeline memory\n\nWorking folder: ${p.workdir || "(bridge default)"}\n\n## Progress log\n`,
  });
  return p;
}

export async function updateProject(
  id: string,
  patch: Partial<Pick<PipelineProject, "name" | "prompt" | "workdir" | "phase" | "iteration" | "planDone" | "execDone">>
): Promise<PipelineProject | null> {
  const p = await getProject(id);
  if (!p) return null;
  const next: PipelineProject = { ...p, ...patch, updatedAt: new Date().toISOString() };
  if (patch.workdir !== undefined) next.workdir = cleanWorkdir(patch.workdir);
  await kvSet(NS_PROJ, id, next);
  return next;
}

export async function deleteProject(id: string): Promise<boolean> {
  const p = await getProject(id);
  if (!p) return false;
  await kvDel(NS_PROJ, id);
  await kvDel(NS_MEM, id);
  for (const phase of ["planning", "executing", "reviewing"]) await kvDel(NS_DOC, `${id}:${phase}`);
  return true;
}

export async function readProjectMemory(id: string): Promise<string> {
  const v = await kvGet<{ text?: string }>(NS_MEM, id);
  return String(v?.text ?? "");
}

export async function readProjectMemoryTail(id: string): Promise<string> {
  const all = await readProjectMemory(id);
  return all.length > MEMORY_INJECT ? all.slice(all.length - MEMORY_INJECT) : all;
}

export async function appendProjectMemory(id: string, entry: string): Promise<void> {
  if (!entry.trim()) return;
  const p = await getProject(id);
  if (!p) return;
  const prev = await readProjectMemory(id);
  const stamp = new Date().toISOString();
  await kvSet(NS_MEM, id, { text: `${prev}\n### ${stamp}\n${entry.trim()}\n` });
}

const PHASE_DOC_TITLE: Record<string, string> = {
  planning: "Planning",
  executing: "Execution",
  reviewing: "Review & Test",
};

// Store a phase's report (summary text) in the DB so the phone can show each
// team's output. The Obsidian markdown mirror (which needs the workdir's plan.md
// / error.md on disk) is done laptop-side by the bridge, not here.
export async function writePhaseDoc(id: string, phase: string, summary: string): Promise<boolean> {
  if (!PHASE_DOC_TITLE[phase]) return false;
  const p = await getProject(id);
  if (!p) return false;
  await kvSet(NS_DOC, `${id}:${phase}`, {
    title: PHASE_DOC_TITLE[phase],
    iteration: p.iteration,
    summary: (summary || "").trim(),
    updatedAt: new Date().toISOString(),
  });
  return true;
}

export async function readPhaseDoc(
  id: string,
  phase: string
): Promise<{ title: string; iteration: number; summary: string; updatedAt: string } | null> {
  return kvGet(NS_DOC, `${id}:${phase}`);
}
