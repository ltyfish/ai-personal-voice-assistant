// Coding-mode project store + scoped file tools (LOCAL ONLY).
//
// Each coding project is a folder on the user's machine under the Ollama dir
// (next to soul.md), holding:
//   meta.json  — { id, name, slug, model, task, workdir, status, createdAt, updatedAt }
//   memory.md  — rolling progress log the autonomous loop appends to as it works.
//
// This is filesystem state on the USER'S machine, so it only works when the Next
// server runs locally (npm run dev) — which is the only time coding mode is used.
// Everything is best-effort; a missing folder is created on demand.
//
// The file tools (read/write/edit/list) are SCOPED to a project's `workdir`: a
// path that resolves outside the workdir is rejected. That scoping is the safety
// boundary for autonomous, no-confirm file edits.

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { randomUUID } from "node:crypto";

// Coding projects live under the Hermes folder (override with CODING_DIR).
const CODING_BASE =
  process.env.CODING_DIR || "C:\\Users\\User\\Downloads\\Projects\\Hermes";
const ROOT = join(CODING_BASE, "coding");

const MEMORY_INJECT = 6000; // chars of memory.md fed back into the prompt
const MAX_FILE_BYTES = 200_000; // cap a single read_file result (~50k tokens)
const MAX_LIST = 400; // cap list_dir entries

export type CodingStatus = "idle" | "running" | "done" | "error";
export type CodingProject = {
  id: string;
  name: string;
  slug: string;
  model: string;
  task: string;
  workdir: string;
  status: CodingStatus;
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
  // De-dupe against existing folders.
  ensureRoot();
  let slug = base;
  let n = 2;
  while (existsSync(join(ROOT, slug))) slug = `${base}-${n++}`;
  return slug;
}

function projDir(slug: string) {
  return join(ROOT, slug);
}
function metaPath(slug: string) {
  return join(projDir(slug), "meta.json");
}
function memoryPath(slug: string) {
  return join(projDir(slug), "memory.md");
}

function readMeta(slug: string): CodingProject | null {
  try {
    const raw = readFileSync(metaPath(slug), "utf8");
    const m = JSON.parse(raw);
    return m && m.id ? (m as CodingProject) : null;
  } catch {
    return null;
  }
}

function writeMeta(p: CodingProject) {
  ensureRoot();
  if (!existsSync(projDir(p.slug))) mkdirSync(projDir(p.slug), { recursive: true });
  writeFileSync(metaPath(p.slug), JSON.stringify(p, null, 2));
}

export function listProjects(): CodingProject[] {
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
    .filter((p): p is CodingProject => !!p)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getProject(id: string): CodingProject | null {
  return listProjects().find((p) => p.id === id) || null;
}

export function createProject(input: {
  name: string;
  model: string;
  task: string;
  workdir: string;
}): CodingProject {
  const name = (input.name || "").trim() || "Untitled project";
  const slug = slugify(name);
  const now = new Date().toISOString();
  // A working folder is optional: for a brand-new project the user has no folder
  // yet, so default to a `workspace` dir inside the project's own folder and
  // create it. An explicit path (e.g. an existing repo) overrides this.
  let workdir = (input.workdir || "").trim();
  if (!workdir) {
    workdir = join(projDir(slug), "workspace");
    try { mkdirSync(workdir, { recursive: true }); } catch { /* best-effort */ }
  }
  const p: CodingProject = {
    id: randomUUID(),
    name,
    slug,
    model: (input.model || "").trim(),
    task: (input.task || "").trim(),
    workdir,
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
  writeMeta(p);
  // Seed an empty memory file with a header.
  if (!existsSync(memoryPath(slug))) {
    writeFileSync(
      memoryPath(slug),
      `# ${name} — coding memory\n\nWorking folder: ${p.workdir}\nTask: ${p.task}\n\n## Progress log\n`
    );
  }
  return p;
}

export function updateProject(
  id: string,
  patch: Partial<Pick<CodingProject, "name" | "model" | "task" | "workdir" | "status">>
): CodingProject | null {
  const p = getProject(id);
  if (!p) return null;
  const next: CodingProject = {
    ...p,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
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

// The recent tail of memory, for injecting into the loop's prompt.
export function readProjectMemoryTail(id: string): string {
  const all = readProjectMemory(id);
  return all.length > MEMORY_INJECT ? all.slice(all.length - MEMORY_INJECT) : all;
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

// ── Scoped file tools ───────────────────────────────────────────────────────
// Resolve `rel` against the project workdir and refuse anything that escapes it.
function safeResolve(workdir: string, rel: string): string | null {
  if (!workdir) return null;
  const root = resolve(workdir);
  // Treat an absolute path inside the workdir as fine; otherwise join.
  const target = isAbsolute(rel) ? resolve(rel) : resolve(root, rel);
  const r = relative(root, target);
  if (r === "") return target; // the root itself
  if (r.startsWith("..") || isAbsolute(r)) return null; // escaped the workdir
  return target;
}

type FileArgs = Record<string, any>;

export function runCodingFileTool(
  workdir: string,
  name: string,
  args: FileArgs
): { ok: boolean; [k: string]: any } {
  const rel = String(args?.path ?? args?.file ?? "");
  switch (name) {
    case "list_dir": {
      const dir = safeResolve(workdir, rel || ".");
      if (!dir) return { ok: false, error: "path is outside the project folder" };
      try {
        if (!existsSync(dir)) return { ok: false, error: "no such folder" };
        const entries = readdirSync(dir, { withFileTypes: true })
          .slice(0, MAX_LIST)
          .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
        return { ok: true, path: rel || ".", entries };
      } catch (e: any) {
        return { ok: false, error: e?.message || "couldn't list folder" };
      }
    }
    case "read_file": {
      const f = safeResolve(workdir, rel);
      if (!f) return { ok: false, error: "path is outside the project folder" };
      try {
        if (!existsSync(f) || !statSync(f).isFile()) return { ok: false, error: "no such file" };
        let content = readFileSync(f, "utf8");
        const truncated = content.length > MAX_FILE_BYTES;
        if (truncated) content = content.slice(0, MAX_FILE_BYTES);
        return { ok: true, path: rel, content, truncated };
      } catch (e: any) {
        return { ok: false, error: e?.message || "couldn't read file" };
      }
    }
    case "write_file": {
      const f = safeResolve(workdir, rel);
      if (!f) return { ok: false, error: "path is outside the project folder" };
      try {
        const d = dirname(f);
        if (!existsSync(d)) mkdirSync(d, { recursive: true });
        writeFileSync(f, String(args?.content ?? ""));
        return { ok: true, path: rel, message: `Wrote ${rel}` };
      } catch (e: any) {
        return { ok: false, error: e?.message || "couldn't write file" };
      }
    }
    case "edit_file": {
      const f = safeResolve(workdir, rel);
      if (!f) return { ok: false, error: "path is outside the project folder" };
      const oldStr = String(args?.old ?? args?.old_string ?? "");
      const newStr = String(args?.new ?? args?.new_string ?? "");
      if (!oldStr) return { ok: false, error: "edit_file needs the exact old text to replace" };
      try {
        if (!existsSync(f)) return { ok: false, error: "no such file" };
        const content = readFileSync(f, "utf8");
        const count = content.split(oldStr).length - 1;
        if (count === 0) return { ok: false, error: "old text not found in the file" };
        if (count > 1) return { ok: false, error: `old text appears ${count} times — make it unique` };
        writeFileSync(f, content.replace(oldStr, newStr));
        return { ok: true, path: rel, message: `Edited ${rel}` };
      } catch (e: any) {
        return { ok: false, error: e?.message || "couldn't edit file" };
      }
    }
    default:
      return { ok: false, error: `unknown file tool ${name}` };
  }
}
