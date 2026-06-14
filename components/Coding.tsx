"use client";

// Coding mode panel (Local tab). Create a coding project (name, working folder,
// local model, task), then let the assigned model work the task autonomously while
// a live activity feed shows exactly what it's doing. Local-only — needs the bridge
// + Ollama, and the Next dev server (for the project files on disk).

import { useEffect, useRef, useState } from "react";
import type { LocalStatus } from "@/lib/local-presence";
import { runCodingTask, type CodingEvent } from "@/lib/coding-agent";

// How many times we'll auto-resume after the loop hits its step cap before
// pausing for the human. Each cycle is MAX_CODING_ROUNDS steps, so this bounds
// runaway cost while letting a long task finish without manual clicking. Context
// carries across cycles via the project's memory.md (same as clicking Continue).
const MAX_AUTO_CONTINUES = 6;

type Project = {
  id: string;
  name: string;
  slug: string;
  model: string;
  task: string;
  workdir: string;
  status: "idle" | "running" | "done" | "error";
  createdAt: string;
  updatedAt: string;
};

const PHASE_ICON: Record<string, string> = {
  thinking: "💭",
  tool: "⏳",
  result: "•",
  review: "↻",
  done: "✅",
  error: "⚠️",
  info: "›",
};

function statusChip(s: string) {
  const map: Record<string, { label: string; color: string }> = {
    idle: { label: "Idle", color: "#888" },
    running: { label: "Running…", color: "var(--accent, #36e0c8)" },
    done: { label: "Done", color: "#4ade80" },
    error: { label: "Error", color: "#f87171" },
  };
  const m = map[s] || map.idle;
  return (
    <span className="a-chip" style={{ color: m.color, borderColor: m.color }}>
      {m.label}
    </span>
  );
}

export default function Coding({ status }: { status: LocalStatus }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", workdir: "", model: "", task: "" });

  // The project currently being run, its live event feed, and a memory view.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<CodingEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [memoryFor, setMemoryFor] = useState<string | null>(null);
  const [memoryText, setMemoryText] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/coding/projects", { cache: "no-store" });
      const data = await res.json();
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch {
      /* leave as-is */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // Default to auto-rotation: freellmapi picks the best available model (the
    // priority fallback chain) and switches only on failure, so the project isn't
    // tied to one model. The per-project memory.md carries context across switches.
    setForm((f) => ({ ...f, model: f.model || "auto" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll the feed as events arrive.
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [events]);

  async function createProject() {
    if (!form.name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/coding/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (res.ok && data.project) {
        setForm({ name: "", workdir: "", model: form.model, task: "" });
        await refresh();
      } else {
        alert(data.error || "Couldn't create the project.");
      }
    } finally {
      setCreating(false);
    }
  }

  async function run(p: Project) {
    if (running) return;
    setActiveId(p.id);
    setEvents([]);
    setRunning(true);
    setMemoryFor(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const onProgress = (e: CodingEvent) => setEvents((prev) => [...prev.slice(-300), e]);
    try {
      // Auto-continue: if a cycle ends only because it hit the step cap (still
      // working, not done/stopped/stuck), resume automatically instead of waiting
      // for a manual Continue click. Bounded by MAX_AUTO_CONTINUES and the Stop
      // button (ctrl.signal). Any other outcome (done/error/stopped) ends here.
      for (let cycle = 0; cycle <= MAX_AUTO_CONTINUES; cycle++) {
        const res = await runCodingTask(p.id, { signal: ctrl.signal, onProgress, availableModels: status.models });
        if (res.status !== "capped" || ctrl.signal.aborted) break;
        if (cycle === MAX_AUTO_CONTINUES) {
          onProgress({ phase: "info", summary: `Auto-continued ${MAX_AUTO_CONTINUES}× — pausing. Hit Continue to keep going.` });
          break;
        }
        onProgress({ phase: "info", summary: "Auto-continuing past the step cap…" });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      refresh();
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function remove(p: Project) {
    if (!confirm(`Delete project “${p.name}” and its memory?`)) return;
    await fetch(`/api/coding/projects/${p.id}`, { method: "DELETE" });
    if (activeId === p.id) { setActiveId(null); setEvents([]); }
    if (memoryFor === p.id) setMemoryFor(null);
    refresh();
  }

  async function viewMemory(p: Project) {
    if (memoryFor === p.id) { setMemoryFor(null); return; }
    try {
      const res = await fetch(`/api/coding/memory?id=${encodeURIComponent(p.id)}`, { cache: "no-store" });
      const data = await res.json();
      setMemoryText(data.memory || "(empty)");
      setMemoryFor(p.id);
    } catch {
      setMemoryText("(couldn't read memory)");
      setMemoryFor(p.id);
    }
  }

  const models = status.models;

  return (
    <div>
      {/* New project */}
      <section className="a-card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>New coding project</h3>
        <p className="tab-sub" style={{ marginTop: 0 }}>
          Assign a local model a task in a working folder. It works autonomously —
          reading, editing, running commands and self-reviewing — until done.
        </p>
        <div style={{ display: "grid", gap: 8 }}>
          <input
            className="a-input"
            placeholder="Project name (e.g. Refactor parser)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="a-input"
            placeholder="Working folder — optional, full path (e.g. C:\Users\You\code\myapp)"
            value={form.workdir}
            onChange={(e) => setForm({ ...form, workdir: e.target.value })}
          />
          <select
            className="a-input"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          >
            <option value="auto">Auto — rotate models (recommended)</option>
            {models.map((m) => (
              <option key={m} value={m}>{m} (pinned)</option>
            ))}
          </select>
          <textarea
            className="a-input"
            placeholder="Task — what should it build/fix? Be specific."
            rows={3}
            value={form.task}
            onChange={(e) => setForm({ ...form, task: e.target.value })}
          />
          <button
            className="a-btn"
            disabled={creating || !form.name.trim()}
            onClick={createProject}
          >
            {creating ? "Creating…" : "Create project"}
          </button>
        </div>
      </section>

      {/* Project list */}
      <section className="a-card">
        <h3 style={{ marginTop: 0 }}>Projects</h3>
        {loading ? (
          <p className="tab-sub">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="tab-sub">No projects yet — create one above.</p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {projects.map((p) => (
              <div key={p.id} style={{ border: "1px solid var(--border, #2a3a3a)", borderRadius: 10, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong>{p.name}</strong>
                  {statusChip(activeId === p.id && running ? "running" : p.status)}
                  <span className="a-chip">{p.model || "no model"}</span>
                </div>
                <div className="tab-sub" style={{ margin: "6px 0" }}>{p.task || "(no task)"}</div>
                <div style={{ fontSize: 12, opacity: 0.6, wordBreak: "break-all" }}>{p.workdir}</div>
                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  {activeId === p.id && running ? (
                    <button className="a-btn" onClick={stop}>■ Stop</button>
                  ) : (
                    <button className="a-btn" disabled={running || !p.model} onClick={() => run(p)}>
                      {p.status === "idle" && !readMemoryHint(p) ? "▶ Run" : "▶ Continue"}
                    </button>
                  )}
                  <button className="a-btn a-btn-ghost" onClick={() => viewMemory(p)}>
                    {memoryFor === p.id ? "Hide memory" : "View memory"}
                  </button>
                  <button className="a-btn a-btn-ghost" onClick={() => remove(p)}>Delete</button>
                </div>

                {/* Live activity feed for the running project */}
                {activeId === p.id && events.length > 0 && (
                  <div
                    ref={feedRef}
                    style={{
                      marginTop: 10,
                      maxHeight: 280,
                      overflowY: "auto",
                      background: "rgba(0,0,0,0.25)",
                      borderRadius: 8,
                      padding: 10,
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 12.5,
                      lineHeight: 1.6,
                    }}
                  >
                    {events.map((e, i) => (
                      <div
                        key={i}
                        style={{
                          opacity: e.phase === "thinking" ? 0.65 : 1,
                          color:
                            e.status === "failed" || e.phase === "error" ? "#f87171"
                            : e.phase === "done" ? "#4ade80"
                            : e.status === "ok" ? "var(--accent, #36e0c8)"
                            : "inherit",
                        }}
                      >
                        <span style={{ opacity: 0.7 }}>{e.round ? `[${e.round}] ` : ""}</span>
                        {PHASE_ICON[e.phase] || "›"} {e.summary}
                        {e.detail ? <span style={{ opacity: 0.7 }}> — {e.detail}</span> : null}
                      </div>
                    ))}
                  </div>
                )}

                {/* Persisted memory.md */}
                {memoryFor === p.id && (
                  <pre
                    style={{
                      marginTop: 10,
                      maxHeight: 280,
                      overflowY: "auto",
                      background: "rgba(0,0,0,0.25)",
                      borderRadius: 8,
                      padding: 10,
                      fontSize: 12,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {memoryText}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// A project that already has progress should say "Continue" instead of "Run".
function readMemoryHint(p: Project): boolean {
  return p.status === "done" || p.status === "error";
}
