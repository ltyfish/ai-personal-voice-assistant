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
import { runPhase, orderChainForDifficulty, type PipelineEvent, type Phase, type Difficulty } from "@/lib/pipeline-agent";
import { loadPipelineConfig, savePipelineConfig, PIPELINE_LIMITS, type PipelineConfig } from "@/lib/pipeline-config";
import { publishModel, setIdle, logRoute } from "@/lib/model-hud";
import { byBestModel } from "@/lib/model-rank";
import { notify, confirmDialog } from "@/lib/toast";
import { relayRun, fetchPipelineEvents } from "@/lib/relay-client";

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

// REMOTE phase execution: when the app is served from the cloud (not a local dev
// server), the in-browser loop can't reach the laptop's filesystem, so the phase
// runs on the laptop BRIDGE instead. We relay a `pipeline_phase` start command and
// stream the bridge's progress back via /api/pipeline/events, replaying each event
// into the SAME onProgress feed so the higher-level run logic is unchanged. Returns
// the same PhaseResult shape as runPhase so it's a drop-in at the runPhaseResilient
// seam.
async function runPhaseRemote(
  projectId: string,
  phase: Phase,
  models: string[],
  opts: { onProgress: (e: PipelineEvent) => void; signal?: AbortSignal; cfg: PipelineConfig }
): Promise<{ status: "done" | "stopped" | "error" | "capped"; summary: string }> {
  const started = await relayRun(
    { action: "pipeline_phase", projectId, phase, models, cfg: opts.cfg },
    { timeoutMs: 30_000 }
  );
  if (!started.httpOk || started.data?.started !== true) {
    const err = String(started.data?.error || "Couldn't start the phase on your computer (is the bridge online?).");
    opts.onProgress({ phase: "error", summary: err });
    return { status: "error", summary: err };
  }
  const TERMINAL = new Set(["done", "stopped", "capped", "error"]);
  let since = -1;
  let result: { status: "done" | "stopped" | "error" | "capped"; summary: string } = {
    status: "error",
    summary: "no progress received from your computer",
  };
  for (;;) {
    if (opts.signal?.aborted) {
      relayRun({ action: "pipeline_stop", projectId }, { timeoutMs: 10_000 }).catch(() => {});
      return { status: "stopped", summary: "Stopped." };
    }
    const batch = await fetchPipelineEvents(projectId, since);
    let done = false;
    for (const e of batch.events) {
      since = e.i;
      opts.onProgress(e as PipelineEvent);
      if (TERMINAL.has(e.phase)) {
        done = true;
        result = { status: e.phase as typeof result.status, summary: e.summary || result.summary };
      }
    }
    if (done) break;
    if (!batch.running) break; // safety: run ended without a terminal event reaching us
    await new Promise((r) => setTimeout(r, 1200));
  }
  return result;
}

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

  // ── tunable run knobs (autonomy, retries, token caps, smart routing) ──
  // Kept in a ref too so the long-lived async run loops read the LATEST value
  // (state closures inside a running pipeline would otherwise go stale).
  const [cfg, setCfgState] = useState<PipelineConfig>(() => loadPipelineConfig());
  const cfgRef = useRef(cfg);
  function setCfg(next: Partial<PipelineConfig>) {
    const merged = savePipelineConfig({ ...cfgRef.current, ...next });
    cfgRef.current = merged;
    setCfgState(merged);
  }

  // ── which model the running phase is actually using (live) ──
  const [activeModel, setActiveModel] = useState<string>("");

  // Run phases on the laptop BRIDGE whenever the app isn't served from a local dev
  // server: the in-browser loop's file tools hit cloud routes that can't see the
  // laptop disk, so a cloud/phone session must drive the bridge instead. On
  // localhost (npm run dev) the original in-browser loop still works directly.
  const remote = useMemo(
    () =>
      typeof window !== "undefined" &&
      !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(window.location.hostname),
    []
  );
  // Pick the executor for ONE phase — remote (bridge) or the local in-browser loop.
  const runOnePhase = (
    projectId: string,
    phase: Phase,
    chain: string[],
    runOpts: { onProgress: (e: PipelineEvent) => void; signal?: AbortSignal; cfg: PipelineConfig; runningPhase?: string }
  ) =>
    remote
      ? runPhaseRemote(projectId, phase, chain, runOpts)
      : runPhase(projectId, phase, chain, runOpts);

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

  // Persist a checkpoint flag so a rerun can resume past a finished phase.
  async function setCheckpoint(id: string, patch: { planDone?: boolean; execDone?: boolean }) {
    try {
      await fetch(`/api/pipeline/projects/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
    } catch { /* best-effort */ }
  }

  // Run a phase, auto-continuing if it hits the step cap (resilient to long
  // tasks). Hitting the cap means the model was still making PROGRESS (the loop
  // bails on its own when a model errors or gets stuck), so a long task keeps
  // going. Each continue re-preps the phase and reads the memory tail, so
  // context carries over — a fresh step budget, not a restart. The user can Stop
  // at any time. The cap-continue ceiling is the `capContinues` knob.
  async function runPhaseResilient(
    projectId: string, phase: Phase, models: string[],
    opts: { signal: AbortSignal; runningPhase: string }
  ) {
    const max = cfgRef.current.capContinues;
    const runOpts = { onProgress, cfg: cfgRef.current, ...opts };
    let res = await runOnePhase(projectId, phase, models, runOpts);
    let cont = 0;
    while (res.status === "capped" && cont < max && !opts.signal.aborted) {
      cont++;
      onProgress({ phase: "info", summary: `Step limit hit — auto-continuing (${cont}/${max})…` });
      res = await runOnePhase(projectId, phase, models, runOpts);
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

  // Smart execution routing: rate the task once (cheap rotated call) and reorder
  // the Execution chain so it STARTS at the matching model tier (easy → weaker
  // models, hard → strongest) while still escalating upward on failure. When
  // smart routing is off, the chain is used as configured (best-first).
  async function execChainFor(p: Project): Promise<string[]> {
    const chain = chainFor("execution");
    if (!cfgRef.current.smartRouting || chain.length <= 1) return chain;
    try {
      const res = await fetch("/api/pipeline/classify", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: p.id }),
      });
      const data = await res.json().catch(() => ({}));
      const difficulty = (["easy", "medium", "hard"].includes(data?.difficulty) ? data.difficulty : "hard") as Difficulty;
      const ordered = orderChainForDifficulty(chain, difficulty);
      onProgress({ phase: "info", team: "Execution", model: ordered[0], summary: `Task rated ${difficulty} — starting execution at ${ordered[0]}.` });
      return ordered;
    } catch {
      return chain; // classifier unreachable → use the configured order
    }
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
      const execChain = await execChainFor(p);
      if (ctrl.signal.aborted) return false;
      const exec = await runPhaseResilient(p.id, "executing", execChain, { ...common, runningPhase: "executing" });
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

  // Run a project: Planning → Execution, then Review & Test. In AUTONOMOUS mode
  // (the default) Review + auto-fix run end-to-end with no manual gate; otherwise
  // it STOPS after execution and prompts. When `resume` is set, skip phases
  // already checkpointed for this iteration so a rerun picks up where it stopped.
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

      if (!teams.reviewEnabled) {
        await setProjPhase(p.id, "done");
        onProgress({ phase: "done", summary: "Pipeline complete (review skipped)." });
      } else if (cfgRef.current.autonomous) {
        // Fully autonomous: go straight into Review & Test + auto-fix.
        onProgress({ phase: "info", summary: "Execution finished — running Review & Test autonomously…" });
        await reviewLoop(p, ctrl);
      } else {
        await setProjPhase(p.id, "awaiting_review");
        setAwaitingReview(p.id);
        onProgress({ phase: "info", summary: "Execution finished. Run Review & Test? (decide below)" });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      refresh();
    }
  }

  // The Review & Test loop: review, and if it reports critical issues and
  // auto-fix is on, auto plan→execute a fix and review again until it PASSES or
  // the auto-fix round cap is hit (then hand back). Assumes the caller owns the
  // running/abort lifecycle (runReview sets it up; runProject reuses its own).
  async function reviewLoop(p: Project, ctrl: AbortController) {
    // How many auto-replan/re-execute rounds before handing back to the user.
    const MAX_AUTO_FIX_ROUNDS = cfgRef.current.autoFixRounds;
    // Default ON: a config that predates this flag (undefined) must NOT silently
    // disable auto-fix — that's the bug where Review reported ISSUES and nothing redid.
    const autoFix = teams.autoFixEnabled ?? true;
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
  }

  // Manual entry point for Review & Test (the gate button): owns the run lifecycle.
  async function runReview(p: Project) {
    if (running) return;
    setActiveId(p.id);
    setAwaitingReview(null);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await reviewLoop(p, ctrl);
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

  // Friendly labels + hints for the numeric knobs (order = display order).
  const KNOBS: { key: keyof typeof PIPELINE_LIMITS; label: string; hint: string; fmt?: (n: number) => string }[] = [
    { key: "maxRoundsPerPhase", label: "Max steps / phase", hint: "Tool steps before a phase pauses (resumable)." },
    { key: "capContinues", label: "Auto-continues", hint: "Times a paused (step-capped) phase auto-continues." },
    { key: "autoFixRounds", label: "Auto-fix rounds", hint: "Re-plan/re-execute rounds when Review reports issues." },
    { key: "modelRetries", label: "Model retries", hint: "Same-model retries on a transient blip before escalating." },
    { key: "repeatNudgeAt", label: "Repeat nudge at", hint: "Identical calls before nudging the model to move on." },
    { key: "repeatAbortAt", label: "Repeat abort at", hint: "Identical calls before escalating to the next model." },
    { key: "toolResultCap", label: "Tool result cap", hint: "Max chars kept per tool result (lower = fewer tokens).", fmt: (n) => `${n} ch` },
    { key: "keepFullRounds", label: "Keep full rounds", hint: "Recent rounds kept verbatim before older results are stubbed." },
    { key: "temperature", label: "Temperature", hint: "Sampling randomness for the model calls.", fmt: (n) => n.toFixed(2) },
  ];

  return (
    <div>
      {/* Run knobs — autonomy, reliability + token economy. Collapsed by default. */}
      <details className="collapse">
        <summary>
          Pipeline settings (autonomy &amp; limits)
          <span className="col-caret" />
        </summary>
        <div className="collapse-body">
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
            <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
              title="After execution, run Review & Test (+ auto-fix) end-to-end with no manual gate.">
              <input type="checkbox" checked={cfg.autonomous} onChange={(e) => setCfg({ autonomous: e.target.checked })} />
              Fully autonomous (no review gate)
            </label>
            <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
              title="Rate the task easy/medium/hard and start execution at the matching model tier (easy → weaker, hard → strongest).">
              <input type="checkbox" checked={cfg.smartRouting} onChange={(e) => setCfg({ smartRouting: e.target.checked })} />
              Smart model routing (difficulty-based)
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            {KNOBS.map(({ key, label, hint, fmt }) => {
              const lim = PIPELINE_LIMITS[key];
              const val = cfg[key];
              return (
                <label key={key} style={{ fontSize: 12.5 }} title={hint}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                    <span>{label}</span>
                    <span className="mono" style={{ opacity: 0.8 }}>{fmt ? fmt(val) : val}</span>
                  </div>
                  <input type="range" min={lim.min} max={lim.max} step={lim.step} value={val}
                    onChange={(e) => setCfg({ [key]: Number(e.target.value) } as Partial<PipelineConfig>)}
                    style={{ width: "100%" }} />
                </label>
              );
            })}
          </div>
          <p className="tab-sub" style={{ fontSize: 11.5, marginBottom: 0 }}>
            Key-rotation depth (keys tried per model) is a router-wide setting — see Rotation settings on the LLM Keys tab.
          </p>
        </div>
      </details>

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
