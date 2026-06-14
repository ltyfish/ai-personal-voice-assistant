"use client";

// Pipeline mode (Local tab). A 3-team coding workflow:
//   Planning → Execution → Review & Test (optional)
// Each team is an ordered, reorderable list of OpenRouter models (assign any model
// to any team). You send a prompt; the Planning team studies the codebase and writes
// a plan, then the Execution team implements ONLY that plan, then (optionally) the
// Review & Test team verifies. A status board shows every OpenRouter account/key and
// model availability. Local-only — needs the bridge + freellmapi + the Next dev server.

import { useEffect, useMemo, useRef, useState } from "react";
import type { LocalStatus } from "@/lib/local-presence";
import { openrouterStatus, type ProviderKey, type ProviderModel } from "@/lib/bridge";
import { runPhase, type PipelineEvent, type Phase } from "@/lib/pipeline-agent";
import { publishModel, setIdle, logRoute } from "@/lib/model-hud";
import { byBestModel } from "@/lib/model-rank";
import { notify, confirmDialog } from "@/lib/toast";

type Project = {
  id: string;
  name: string;
  slug: string;
  prompt: string;
  workdir: string;
  phase: string;
  iteration: number;
  planDone?: boolean;
  execDone?: boolean;
  createdAt: string;
  updatedAt: string;
};

type Teams = {
  planning: string[];
  execution: string[];
  review: string[];
  reviewEnabled: boolean;
  autoFixEnabled?: boolean; // when Review finds critical issues, auto plan→exec→review again
};

// How many times the pipeline may auto-replan/re-execute when Review keeps
// reporting critical issues, before it stops and hands back to the user.
const MAX_AUTO_FIX_ROUNDS = 3;

// Did the Review team's verdict report critical/blocking issues? Prefer the
// explicit VERDICT line the prompt asks for; fall back to keyword heuristics
// only if the model didn't emit a clean verdict.
function reviewFoundIssues(summary: string): boolean {
  const s = summary || "";
  if (/VERDICT:\s*ISSUES/i.test(s)) return true;
  if (/VERDICT:\s*PASS/i.test(s)) return false;
  return /\b(critical|blocking|incomplete|not implemented|placeholder|stub|does not (build|compile|run)|build fail|tests? fail)\b/i.test(s);
}

// v3: each team now seeds with ALL available models (best→least), not a capped 6,
// so the cards represent the real chain. (v2: execution best-first + autoFixEnabled.)
// Bumping the key drops stale configs so the new defaults actually take effect.
// v4: model ids are now "<platform>/<model>" (the router format), not bare model
// ids — bump so stale bare-id team configs are dropped and re-seeded.
const TEAMS_KEY = "pipeline.teams.v4";
const PHASE_ICON: Record<string, string> = {
  thinking: "💭", tool: "⏳", result: "•", review: "↻", done: "✅", error: "⚠️", info: "›",
};

// One row of /api/llm-keys/usage — used only to surface every model the LLM Keys
// rotation can serve, so the team pickers list them (best-first) without a board.
type UsageModel = {
  platform: string; model: string;
  totalTokens: number; todayTokens: number;
  promptTokens: number; completionTokens: number;
  requests: number; keyCount: number; rank: number;
};

export default function Pipeline({ status }: { status: LocalStatus }) {
  // ── status board (freellmapi — still drives the team model pickers) ──
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [boardErr, setBoardErr] = useState("");

  // ── native LLM-Keys token usage (feeds the team model pickers, best-first) ──
  const [usageModels, setUsageModels] = useState<UsageModel[]>([]);

  // ── team config ──
  const [teams, setTeams] = useState<Teams>({ planning: [], execution: [], review: [], reviewEnabled: true, autoFixEnabled: true });
  const seededRef = useRef(false);

  // ── which model the running phase is actually using (live) ──
  const [activeModel, setActiveModel] = useState<string>("");

  // ── projects + run state ──
  const [projects, setProjects] = useState<Project[]>([]);
  const [form, setForm] = useState({ name: "", workdir: "", prompt: "" });
  const [creating, setCreating] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [awaitingReview, setAwaitingReview] = useState<string | null>(null);
  const [followup, setFollowup] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);

  // Every model the team pickers can assign — the union of the LLM-Keys rotation
  // (catalog ∪ models with recorded usage), de-duped (the same model is served by
  // several keys/accounts) and sorted best-first. Ids are "<platform>/<model>" so
  // they can be sent straight to the router (/api/v1).
  const modelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of models) ids.add(`${m.platform}/${m.modelId}`);
    for (const m of usageModels) ids.add(`${m.platform}/${m.model}`);
    return [...ids].sort(byBestModel((id) => id));
  }, [models, usageModels]);

  // A team's run chain is simply its saved order.
  const chainFor = (key: "planning" | "execution" | "review") => teams[key];

  async function loadBoard() {
    const r = await openrouterStatus();
    if (r.ok) {
      setKeys(r.keys || []);
      setModels(r.models || []);
      setBoardErr("");
    } else {
      setBoardErr(r.error || "Couldn't load OpenRouter status.");
    }
  }

  async function loadUsage() {
    try {
      const res = await fetch("/api/llm-keys/usage", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) return;
      setUsageModels(Array.isArray(data.models) ? data.models : []);
    } catch { /* leave as-is — team pickers fall back to the catalog */ }
  }

  async function refresh() {
    try {
      const res = await fetch("/api/pipeline/projects", { cache: "no-store" });
      const data = await res.json();
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch { /* leave as-is */ }
  }

  useEffect(() => {
    loadBoard();
    loadUsage();
    refresh();
    try {
      const raw = localStorage.getItem(TEAMS_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Teams;
        setTeams(saved);
        // Only treat it as "already configured" if at least one card has models;
        // otherwise let the default seeding fill the cards once models load.
        if ((saved.planning?.length || saved.execution?.length || saved.review?.length)) {
          seededRef.current = true;
        }
      }
    } catch { /* ignore */ }
    const t = setInterval(() => { loadBoard(); loadUsage(); }, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed sensible default ordering once models are known (only if the user has no
  // saved config yet): every model on the board, best-first, in each team.
  useEffect(() => {
    if (seededRef.current || modelIds.length === 0) return;
    seededRef.current = true;
    const next: Teams = {
      planning: [...modelIds],
      execution: [...modelIds],
      review: [...modelIds],
      reviewEnabled: true,
      autoFixEnabled: true,
    };
    saveTeams(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelIds]);

  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }); }, [events]);

  function saveTeams(next: Teams) {
    setTeams(next);
    try { localStorage.setItem(TEAMS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }
  function setTeamList(key: keyof Teams, list: string[]) {
    saveTeams({ ...teams, [key]: list } as Teams);
  }
  function moveModel(key: "planning" | "execution" | "review", i: number, dir: -1 | 1) {
    const list = [...teams[key]];
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setTeamList(key, list);
  }
  function removeModel(key: "planning" | "execution" | "review", id: string) {
    setTeamList(key, teams[key].filter((m) => m !== id));
  }
  function addModel(key: "planning" | "execution" | "review", id: string) {
    if (!id || teams[key].includes(id)) return;
    setTeamList(key, [...teams[key], id]);
  }

  async function createProject() {
    if (!form.name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/pipeline/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (res.ok && data.project) {
        setForm({ name: "", workdir: "", prompt: "" });
        await refresh();
      } else notify(data.error || "Couldn't create the project.", "error");
    } finally { setCreating(false); }
  }

  const onProgress = (e: PipelineEvent) => {
    if (e.model) {
      setActiveModel(e.model);
      // Mirror the active model into the floating HUD so it's visible from any tab.
      publishModel("pipeline", e.model, e.team ? `${e.team} phase` : "", true);
    }
    // Surface phase milestones (start/handoff/done/error) in the HUD routing log.
    if (e.phase === "done") setIdle("pipeline", "done");
    else if (e.phase === "error") setIdle("pipeline", "error");
    else if (e.phase === "review" && /↻|handing off|Switched/.test(e.summary))
      logRoute("pipeline", e.summary.slice(0, 80));
    setEvents((prev) => [...prev.slice(-400), e]);
  };

  // How many extra times to auto-continue a phase that hits the 30-step cap.
  // Hitting the cap means the model was still making PROGRESS (the loop already
  // bails out on its own when a model errors or gets stuck repeating), so a long
  // task should keep going rather than be abandoned half-done. Each continue
  // re-preps the phase and reads the memory tail, so context carries over — it's
  // a fresh step budget, not a restart. High ceiling = effectively "keep going
  // until done"; the user can still Stop at any time.
  const PHASE_CAP_CONTINUES = 30;

  // Persist a checkpoint flag so a rerun can resume past a finished phase.
  async function setCheckpoint(id: string, patch: { planDone?: boolean; execDone?: boolean }) {
    try {
      await fetch(`/api/pipeline/projects/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
    } catch { /* best-effort */ }
  }

  // Run a phase, auto-continuing if it hits the step cap (resilient to long tasks).
  async function runPhaseResilient(
    projectId: string, phase: Phase, models: string[],
    opts: { signal: AbortSignal; runningPhase: string }
  ) {
    let res = await runPhase(projectId, phase, models, { onProgress, ...opts });
    let cont = 0;
    while (res.status === "capped" && cont < PHASE_CAP_CONTINUES && !opts.signal.aborted) {
      cont++;
      onProgress({ phase: "info", summary: `Step limit hit — auto-continuing (${cont}/${PHASE_CAP_CONTINUES})…` });
      res = await runPhase(projectId, phase, models, { onProgress, ...opts });
    }
    return res;
  }

  // Decide what a finished phase means for the run. Returns true only when the
  // phase genuinely completed (proceed to the next). A `capped` phase is NOT a
  // failure — the model ran out of step budget while still working, so we leave
  // it PAUSED and resumable (its memory + any checkpoint are preserved) instead
  // of marking the whole pipeline errored and forcing a from-scratch redo.
  async function handlePhaseOutcome(
    id: string, phase: Phase, res: { status: string }, aborted: boolean
  ): Promise<boolean> {
    if (res.status === "done" && !aborted) return true;
    if (aborted || res.status === "stopped") { await setProjPhase(id, "idle"); return false; }
    if (res.status === "capped") {
      await setProjPhase(id, phase); // stays on this phase, resumable
      onProgress({ phase: "info", summary: `${phase} paused at the step limit — progress saved. Hit ▶/⏯ to continue from here (nothing is lost).` });
      return false;
    }
    await setProjPhase(id, "error");
    return false;
  }

  // Run Planning → Execution for one iteration (honouring resume checkpoints).
  // Returns true only when BOTH phases genuinely finished (proceed to review).
  async function runPlanExec(p: Project, ctrl: AbortController, resume = false): Promise<boolean> {
    const common = { signal: ctrl.signal };
    if (!(resume && p.planDone)) {
      const plan = await runPhaseResilient(p.id, "planning", chainFor("planning"), { ...common, runningPhase: "planning" });
      if (!(await handlePhaseOutcome(p.id, "planning", plan, ctrl.signal.aborted))) return false;
      await setCheckpoint(p.id, { planDone: true });
    } else {
      onProgress({ phase: "info", summary: "Resuming — planning already done, skipping to execution." });
    }

    if (!(resume && p.execDone)) {
      const exec = await runPhaseResilient(p.id, "executing", chainFor("execution"), { ...common, runningPhase: "executing" });
      if (!(await handlePhaseOutcome(p.id, "executing", exec, ctrl.signal.aborted))) return false;
      await setCheckpoint(p.id, { execDone: true });
    } else {
      onProgress({ phase: "info", summary: "Resuming — execution already done, skipping to review." });
    }
    return true;
  }

  // Start a fresh iteration to FIX what Review flagged: bump iteration (→ a new
  // plan file), reset checkpoints, keep the original prompt. Planning will read
  // the previous plan + error.md + memory to target the unresolved issues.
  async function startFixIteration(p: Project): Promise<Project | null> {
    try {
      const res = await fetch(`/api/pipeline/projects/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ iteration: p.iteration + 1, phase: "idle", planDone: false, execDone: false }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.project) { await refresh(); return data.project as Project; }
    } catch { /* fall through */ }
    return null;
  }

  // Run a project: Planning → Execution, then (if review enabled) STOP and prompt.
  // When `resume` is set, skip phases already checkpointed for this iteration so a
  // rerun picks up where it stopped instead of redoing planning.
  async function runProject(p: Project, resume = false) {
    if (running) return;
    setActiveId(p.id);
    setEvents([]);
    setActiveModel("");
    setAwaitingReview(null);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      if (!(await runPlanExec(p, ctrl, resume))) return;

      if (teams.reviewEnabled) {
        await setProjPhase(p.id, "awaiting_review");
        setAwaitingReview(p.id);
        onProgress({ phase: "info", summary: "Execution finished. Run Review & Test? (decide below)" });
      } else {
        await setProjPhase(p.id, "done");
        onProgress({ phase: "done", summary: "Pipeline complete (review skipped)." });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      refresh();
    }
  }

  // Run Review & Test, then — if it reports critical issues and auto-fix is on —
  // automatically plan & execute a fix and review again, looping until it PASSES
  // or the auto-fix round cap is hit (then it hands back to the user).
  async function runReview(p: Project) {
    if (running) return;
    setActiveId(p.id);
    setAwaitingReview(null);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    // Default ON: a config that predates this flag (undefined) must NOT silently
    // disable auto-fix — that's the bug where Review reported ISSUES and nothing redid.
    const autoFix = teams.autoFixEnabled ?? true;
    try {
      let current = p;
      for (let autoRound = 0; autoRound <= MAX_AUTO_FIX_ROUNDS; autoRound++) {
        const rev = await runPhaseResilient(current.id, "reviewing", chainFor("review"), { signal: ctrl.signal, runningPhase: "reviewing" });

        if (ctrl.signal.aborted || rev.status === "stopped" || rev.status === "capped") {
          // Not lost — back to the gate so it can be re-run.
          await setProjPhase(current.id, "awaiting_review");
          setAwaitingReview(current.id);
          return;
        }
        if (rev.status === "error") { await setProjPhase(current.id, "error"); return; }

        // status === "done": inspect the verdict.
        if (!autoFix || !reviewFoundIssues(rev.summary)) {
          await setProjPhase(current.id, "done");
          if (autoFix) onProgress({ phase: "done", summary: "Review passed — pipeline complete." });
          else if (reviewFoundIssues(rev.summary)) onProgress({ phase: "info", summary: "Review found issues — auto-fix is off. Use ↻ Fix issues below to re-plan & re-execute." });
          return;
        }

        if (autoRound >= MAX_AUTO_FIX_ROUNDS) {
          await setProjPhase(current.id, "awaiting_review");
          setAwaitingReview(current.id);
          onProgress({ phase: "info", summary: `Review still found issues after ${MAX_AUTO_FIX_ROUNDS} auto-fix round(s) — stopping for you. Add a follow-up prompt or re-run review.` });
          return;
        }

        onProgress({ phase: "review", summary: `Review found critical issues — auto planning & executing a fix (round ${autoRound + 1}/${MAX_AUTO_FIX_ROUNDS})…` });
        const next = await startFixIteration(current);
        if (!next) { await setProjPhase(current.id, "error"); onProgress({ phase: "error", summary: "Couldn't start the auto-fix iteration." }); return; }
        if (!(await runPlanExec(next, ctrl))) return; // a phase stopped/capped/errored; outcome already set
        current = next; // loop back and review the fixed iteration
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      refresh();
    }
  }

  // Manual "redo": when Review reported issues (or auto-fix is off / exhausted),
  // start a fresh fix iteration — re-plan against error.md + the prior plan, then
  // re-execute, ending back at the review gate. Same path auto-fix uses, on demand.
  async function fixIssues(p: Project) {
    if (running) return;
    setActiveId(p.id);
    setAwaitingReview(null);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const next = await startFixIteration(p);
      if (!next) { onProgress({ phase: "error", summary: "Couldn't start the fix iteration." }); return; }
      onProgress({ phase: "review", summary: "Re-planning & re-executing to fix the issues Review flagged…" });
      if (!(await runPlanExec(next, ctrl))) return; // outcome already set on stop/cap/error
      await setProjPhase(next.id, "awaiting_review");
      setAwaitingReview(next.id);
      onProgress({ phase: "info", summary: "Fix executed. Run Review & Test again to confirm." });
    } finally {
      setRunning(false);
      abortRef.current = null;
      refresh();
    }
  }

  async function skipReview(p: Project) {
    setAwaitingReview(null);
    await setProjPhase(p.id, "done");
    onProgress({ phase: "done", summary: "Pipeline complete (review skipped)." });
    refresh();
  }

  // Add a follow-up prompt: a NEW iteration → a NEW plan file (the old plan is never
  // touched), then re-run the whole pipeline against the current codebase.
  async function addFollowup(p: Project) {
    const text = (followup[p.id] || "").trim();
    if (!text || running) return;
    const res = await fetch(`/api/pipeline/projects/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // New iteration → fresh plan, so clear the prior iteration's checkpoints.
      body: JSON.stringify({ prompt: text, iteration: p.iteration + 1, phase: "idle", planDone: false, execDone: false }),
    });
    const data = await res.json().catch(() => ({}));
    setFollowup((f) => ({ ...f, [p.id]: "" }));
    if (res.ok && data.project) { await refresh(); runProject(data.project as Project); }
  }

  async function setProjPhase(id: string, phase: string) {
    try {
      await fetch(`/api/pipeline/projects/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phase }),
      });
    } catch { /* best-effort */ }
  }

  function stop() { abortRef.current?.abort(); }

  async function remove(p: Project) {
    if (!(await confirmDialog(`Delete pipeline "${p.name}" and its memory?`, { confirmLabel: "Delete", danger: true }))) return;
    await fetch(`/api/pipeline/projects/${p.id}`, { method: "DELETE" });
    if (activeId === p.id) { setActiveId(null); setEvents([]); }
    refresh();
  }

  // ── render helpers ──
  function TeamCard({ k, title, hint }: { k: "planning" | "execution" | "review"; title: string; hint: string }) {
    const list = teams[k];
    const unused = modelIds.filter((m) => !list.includes(m));
    return (
      <section className="a-card" style={{ flex: "1 1 260px", minWidth: 240 }}>
        <h4 style={{ margin: "0 0 4px" }}>{title}</h4>
        <p className="tab-sub" style={{ marginTop: 0, fontSize: 12 }}>{hint}</p>
        {list.length === 0 ? (
          <p className="tab-sub" style={{ fontSize: 12 }}>No models — add one below (or it falls back to auto-rotate).</p>
        ) : (
          <ol style={{ margin: "6px 0", paddingLeft: 0, listStyle: "none", display: "grid", gap: 4, maxHeight: 220, overflowY: "auto" }}>
            {list.map((m, i) => (
              <li key={m} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12.5,
                border: "1px solid var(--border)", borderRadius: 8, padding: "4px 7px" }}>
                <span style={{ opacity: 0.5, width: 16 }}>{i + 1}</span>
                <span style={{ flex: 1, wordBreak: "break-all" }}>{m}</span>
                <button className="a-btn a-btn-ghost" style={{ padding: "0 6px" }} onClick={() => moveModel(k, i, -1)} disabled={i === 0}>▲</button>
                <button className="a-btn a-btn-ghost" style={{ padding: "0 6px" }} onClick={() => moveModel(k, i, 1)} disabled={i === list.length - 1}>▼</button>
                <button className="a-btn a-btn-ghost" style={{ padding: "0 6px" }} onClick={() => removeModel(k, m)}>✕</button>
              </li>
            ))}
          </ol>
        )}
        <select className="a-input" value="" onChange={(e) => { addModel(k, e.target.value); e.target.value = ""; }} style={{ fontSize: 12 }}>
          <option value="">+ add model…</option>
          {unused.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </section>
    );
  }

  return (
    <div>
      {/* Teams — collapsed by default so the long model chains stay tidy */}
      <details className="collapse">
        <summary>
          Teams &amp; model order
          {boardErr && <span className="col-sub" title={boardErr}>model list offline</span>}
          <span className="col-caret" />
        </summary>
        <div className="collapse-body">
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
            <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={teams.reviewEnabled} onChange={(e) => saveTeams({ ...teams, reviewEnabled: e.target.checked })} />
              Run Review &amp; Test
            </label>
            <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6, opacity: teams.reviewEnabled ? 1 : 0.4 }}
              title="When Review reports critical issues, auto re-plan, re-execute and review again (up to 3 rounds).">
              <input type="checkbox" checked={teams.autoFixEnabled ?? true} disabled={!teams.reviewEnabled}
                onChange={(e) => saveTeams({ ...teams, autoFixEnabled: e.target.checked })} />
              Auto-fix on issues
            </label>
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <TeamCard k="planning" title="① Planning" hint="Reads the codebase, writes the plan." />
            <TeamCard k="execution" title="② Execution" hint="Implements the plan only." />
            <TeamCard k="review" title="③ Review & Test" hint="Verifies + tests. Optional." />
          </div>
        </div>
      </details>

      {/* New project */}
      <section className="a-card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>New pipeline</h3>
        <div style={{ display: "grid", gap: 8 }}>
          <input className="a-input" placeholder="Name (e.g. Add dark mode)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="a-input" placeholder="Working folder — full path (e.g. C:\Users\You\code\app)" value={form.workdir} onChange={(e) => setForm({ ...form, workdir: e.target.value })} />
          <textarea className="a-input" placeholder="Your prompt — what should the teams build/change?" rows={3} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
          <button className="a-btn" disabled={creating || !form.name.trim()} onClick={createProject}>{creating ? "Creating…" : "Create pipeline"}</button>
        </div>
      </section>

      {/* Projects */}
      <section className="a-card">
        <h3 style={{ marginTop: 0 }}>Pipelines</h3>
        {projects.length === 0 ? (
          <p className="tab-sub">None yet — create one above.</p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {projects.map((p) => (
              <div key={p.id} style={{ border: "1px solid var(--border, #2a3a3a)", borderRadius: 10, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong>{p.name}</strong>
                  <span className="a-chip">{activeId === p.id && running ? "running…" : p.phase}</span>
                  {activeId === p.id && running && activeModel && (
                    <span className="a-chip" title="The model currently driving this phase (updates live as the pipeline rotates)"
                      style={{ background: "var(--a-dim)", color: "var(--t1)" }}>
                      ⚙ {activeModel}
                    </span>
                  )}
                  {p.iteration > 1 && <span className="a-chip">iteration {p.iteration}</span>}
                </div>
                {p.prompt ? (
                  <details className="collapse prompt-collapse" style={{ margin: "8px 0" }}>
                    <summary>Prompt<span className="col-caret" /></summary>
                    <div className="collapse-body" style={{ fontSize: 13, color: "var(--t2)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                      {p.prompt}
                    </div>
                  </details>
                ) : (
                  <div className="tab-sub" style={{ margin: "6px 0" }}>(no prompt)</div>
                )}
                <div style={{ fontSize: 12, opacity: 0.6, wordBreak: "break-all" }}>{p.workdir}</div>

                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  {activeId === p.id && running ? (
                    <button className="a-btn" onClick={stop}>■ Stop</button>
                  ) : (
                    <>
                      <button className="a-btn" disabled={running} onClick={() => runProject(p)}>▶ Run pipeline</button>
                      {(p.planDone || p.execDone) && p.phase !== "done" && (
                        <button className="a-btn a-btn-ghost" disabled={running} onClick={() => runProject(p, true)}
                          title="Continue from the last finished phase (don't redo planning)">
                          ⏯ Resume {p.execDone ? "(review)" : "(execution)"}
                        </button>
                      )}
                    </>
                  )}
                  <button className="a-btn a-btn-ghost" onClick={() => remove(p)}>Delete</button>
                </div>

                {/* Review prompt after execution */}
                {awaitingReview === p.id && !running && (
                  <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: "var(--a-dim)" }}>
                    <div style={{ marginBottom: 8 }}>Execution finished. Run the Review &amp; Test team?</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button className="a-btn" onClick={() => runReview(p)}>▶ Run Review &amp; Test</button>
                      <button className="a-btn a-btn-ghost" onClick={() => fixIssues(p)} title="Re-plan & re-execute to fix what Review flagged, then back to this gate">↻ Fix issues</button>
                      <button className="a-btn a-btn-ghost" onClick={() => skipReview(p)}>Skip — finish</button>
                    </div>
                  </div>
                )}

                {/* Follow-up prompt */}
                {!running && (p.phase === "done" || p.phase === "error" || p.phase === "awaiting_review") && (
                  <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
                    <input className="a-input" placeholder="Add a follow-up prompt (new plan, same codebase)…" value={followup[p.id] || ""}
                      onChange={(e) => setFollowup((f) => ({ ...f, [p.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") addFollowup(p); }} />
                    <button className="a-btn" disabled={!(followup[p.id] || "").trim()} onClick={() => addFollowup(p)}>Add &amp; run</button>
                  </div>
                )}

                {/* Live feed */}
                {activeId === p.id && events.length > 0 && (
                  <>
                  {running && activeModel && (
                    <div style={{ marginTop: 10, fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ opacity: 0.6 }}>Currently using</span>
                      <strong style={{ color: "var(--t1)" }}>{activeModel}</strong>
                    </div>
                  )}
                  <div ref={feedRef} style={{ marginTop: 10, maxHeight: 300, overflowY: "auto", background: "rgba(0,0,0,0.25)",
                    borderRadius: 8, padding: 10, fontFamily: "ui-monospace, monospace", fontSize: 12.5, lineHeight: 1.6 }}>
                    {events.map((e, i) => (
                      <div key={i} style={{ opacity: e.phase === "thinking" ? 0.65 : 1,
                        color: e.status === "failed" || e.phase === "error" ? "#f87171" : e.phase === "done" ? "#4ade80" : e.status === "ok" ? "var(--t1)" : "inherit" }}>
                        <span style={{ opacity: 0.7 }}>{e.team ? `[${e.team}${e.round ? ` ${e.round}` : ""}] ` : e.round ? `[${e.round}] ` : ""}</span>
                        {e.model ? "⚙" : PHASE_ICON[e.phase] || "›"} {e.summary}
                        {e.detail ? <span style={{ opacity: 0.7 }}> — {e.detail}</span> : null}
                      </div>
                    ))}
                  </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
