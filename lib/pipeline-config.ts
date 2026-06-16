// Runtime-tunable knobs for the Pipeline loop (components/Pipeline.tsx +
// lib/pipeline-agent.ts). The pipeline runs CLIENT-side (only the browser can
// reach the localhost bridge for run_shell), so unlike the server-side router
// config (lib/router-config.ts) these live in localStorage. Same defaults +
// bounds + clamp shape so the settings UI sliders stay sane and a bad value can
// never wedge a run. Pure data — safe to import on the client.

export type PipelineConfig = {
  // Per-phase step budget before the phase is PAUSED (resumable). Was MAX_ROUNDS.
  maxRoundsPerPhase: number;
  // How many times a capped (step-limit) phase auto-continues before stopping.
  // Was PHASE_CAP_CONTINUES.
  capContinues: number;
  // Transient same-model retries (network/cold-start/blip) before escalating to
  // the next model in the chain. Was MODEL_RETRY_MAX. (The number of KEYS tried
  // per model is a router-wide setting — see maxKeysPerModel in lib/router-config.ts.)
  modelRetries: number;
  // Auto-fix rounds: when Review reports ISSUES, how many times to re-plan/
  // re-execute/re-review before handing back. Was MAX_AUTO_FIX_ROUNDS.
  autoFixRounds: number;
  // Stuck-loop detection: nudge after this many identical calls, abort/escalate
  // after this many. Were REPEAT_NUDGE_AT / REPEAT_ABORT_AT.
  repeatNudgeAt: number;
  repeatAbortAt: number;
  // Token economy: max chars kept for a fresh tool result, and how many recent
  // rounds keep their results verbatim before being stubbed. Were TOOL_RESULT_CAP
  // / KEEP_FULL_ROUNDS.
  toolResultCap: number;
  keepFullRounds: number;
  // Sampling temperature for the model calls.
  temperature: number;
  // Rate easy/medium/hard once and start execution at the matching model tier
  // (easy → weaker models first, hard → strongest first) to save strong-model quota.
  smartRouting: boolean;
  // Fully autonomous: after execution, run Review & Test (+ auto-fix) end-to-end
  // with no manual gate. Off → the old "Run Review?" prompt.
  autonomous: boolean;
};

export const PIPELINE_DEFAULTS: PipelineConfig = {
  maxRoundsPerPhase: 30,
  capContinues: 30,
  modelRetries: 2,
  autoFixRounds: 3,
  repeatNudgeAt: 2,
  repeatAbortAt: 5,
  toolResultCap: 2000,
  keepFullRounds: 2,
  temperature: 0.2,
  smartRouting: true,
  autonomous: true,
};

// Bounds keep the sliders sane. [min, max, step] per numeric knob.
export const PIPELINE_LIMITS: Record<
  keyof Omit<PipelineConfig, "smartRouting" | "autonomous">,
  { min: number; max: number; step: number }
> = {
  maxRoundsPerPhase: { min: 5, max: 120, step: 5 },
  capContinues: { min: 0, max: 60, step: 1 },
  modelRetries: { min: 0, max: 6, step: 1 },
  autoFixRounds: { min: 0, max: 6, step: 1 },
  repeatNudgeAt: { min: 1, max: 6, step: 1 },
  repeatAbortAt: { min: 2, max: 12, step: 1 },
  toolResultCap: { min: 500, max: 6000, step: 250 },
  keepFullRounds: { min: 1, max: 4, step: 1 },
  temperature: { min: 0, max: 1, step: 0.05 },
};

const STORAGE_KEY = "pipeline.config.v1";

function clampNum(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function normalizePipelineConfig(v: Partial<PipelineConfig> | null): PipelineConfig {
  const d = PIPELINE_DEFAULTS;
  const num = (k: keyof typeof PIPELINE_LIMITS) =>
    clampNum(Number(v?.[k]), PIPELINE_LIMITS[k].min, PIPELINE_LIMITS[k].max, d[k]);
  // repeatAbortAt must stay > repeatNudgeAt or the nudge never fires before abort.
  const nudge = num("repeatNudgeAt");
  const abort = Math.max(nudge + 1, num("repeatAbortAt"));
  return {
    maxRoundsPerPhase: Math.round(num("maxRoundsPerPhase")),
    capContinues: Math.round(num("capContinues")),
    modelRetries: Math.round(num("modelRetries")),
    autoFixRounds: Math.round(num("autoFixRounds")),
    repeatNudgeAt: Math.round(nudge),
    repeatAbortAt: Math.round(abort),
    toolResultCap: Math.round(num("toolResultCap")),
    keepFullRounds: Math.round(num("keepFullRounds")),
    temperature: num("temperature"),
    smartRouting: v?.smartRouting ?? d.smartRouting,
    autonomous: v?.autonomous ?? d.autonomous,
  };
}

export function loadPipelineConfig(): PipelineConfig {
  if (typeof window === "undefined") return { ...PIPELINE_DEFAULTS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizePipelineConfig(raw ? (JSON.parse(raw) as Partial<PipelineConfig>) : null);
  } catch {
    return { ...PIPELINE_DEFAULTS };
  }
}

export function savePipelineConfig(cfg: PipelineConfig): PipelineConfig {
  const next = normalizePipelineConfig(cfg);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota/SSR */
  }
  return next;
}
