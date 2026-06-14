// Shared client-side store for the floating "current model" HUD (the draggable
// sticky pad). It's mounted ONCE at the app root (MailApp) so it survives tab
// switches, and both the JARVIS voice path and the Pipeline path publish into
// it. Pure client module: a tiny pub/sub + a rolling routing log, with the
// HUD's position / hidden state persisted in localStorage.
//
// Two independent "lanes" — one per source — so the pad always shows the latest
// model for each surface side by side regardless of which tab is open.

export type HudSource = "jarvis" | "pipeline";

export type HudLane = {
  model: string; // current model id ("" = idle)
  detail: string; // short status line (e.g. "answered · 1.2k tok", "Execution phase")
  busy: boolean; // a turn/phase is actively running
  at: number; // last-update timestamp (ms)
};

export type HudLogEntry = {
  id: number;
  source: HudSource;
  msg: string;
  at: number;
};

export type HudState = {
  lanes: Record<HudSource, HudLane>;
  log: HudLogEntry[];
  hidden: boolean;
  pos: { x: number; y: number };
};

const POS_KEY = "modelHud.pos.v1";
const HIDDEN_KEY = "modelHud.hidden.v1";
const SIZE_KEY = "modelHud.size.v1";
const MAX_LOG = 60;

// Pad size bounds (px). Min keeps it usable; max keeps it on-screen.
export const HUD_SIZE = { minW: 240, minH: 220, maxW: 620, maxH: 820, defW: 280, defH: 380 };

export function loadHudSize(): { w: number; h: number } {
  if (typeof window === "undefined") return { w: HUD_SIZE.defW, h: HUD_SIZE.defH };
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (typeof s?.w === "number" && typeof s?.h === "number") {
        return {
          w: Math.min(HUD_SIZE.maxW, Math.max(HUD_SIZE.minW, s.w)),
          h: Math.min(HUD_SIZE.maxH, Math.max(HUD_SIZE.minH, s.h)),
        };
      }
    }
  } catch {
    /* fall through to default */
  }
  return { w: HUD_SIZE.defW, h: HUD_SIZE.defH };
}

export function saveHudSize(w: number, h: number) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify({ w, h }));
  } catch {
    /* ignore */
  }
}

function emptyLane(): HudLane {
  return { model: "", detail: "", busy: false, at: 0 };
}

function loadPos(): { x: number; y: number } {
  if (typeof window === "undefined") return { x: 24, y: 96 };
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p?.x === "number" && typeof p?.y === "number") return p;
    }
  } catch {
    /* fall through to default */
  }
  return { x: 24, y: 96 };
}

function loadHidden(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(HIDDEN_KEY) === "1";
}

const state: HudState = {
  lanes: { jarvis: emptyLane(), pipeline: emptyLane() },
  log: [],
  hidden: loadHidden(),
  pos: loadPos(),
};

let logSeq = 1;
const listeners = new Set<(s: HudState) => void>();

// Pass a fresh top-level snapshot to subscribers. The store mutates `state` in
// place, so handing React the SAME object reference makes it bail on the
// re-render (Object.is). A shallow clone gives a new ref each emit; the nested
// lanes/log are re-read fresh by consumers, which is all the HUD needs.
function snapshot(): HudState {
  return { lanes: { ...state.lanes }, log: state.log, hidden: state.hidden, pos: state.pos };
}

function emit() {
  const snap = snapshot();
  for (const fn of listeners) fn(snap);
}

export function subscribeHud(fn: (s: HudState) => void): () => void {
  listeners.add(fn);
  fn(snapshot());
  return () => listeners.delete(fn);
}

export function getHudState(): HudState {
  return snapshot();
}

// Report the model now driving a turn/phase. `busy` defaults to true; pass a
// final detail with busy:false when the turn finishes.
export function publishModel(
  source: HudSource,
  model: string,
  detail = "",
  busy = true
) {
  const lane = state.lanes[source];
  // Only log a routing line when the model actually changes, to avoid spam.
  const changed = model && model !== lane.model;
  lane.model = model || lane.model;
  lane.detail = detail;
  lane.busy = busy;
  lane.at = Date.now();
  if (changed) logRoute(source, `▸ ${model}${detail ? ` — ${detail}` : ""}`);
  else emit();
}

// Mark a lane as actively working before its model is known (e.g. a voice turn
// in flight). Keeps the last model label but lights the "busy" indicator.
export function markThinking(source: HudSource, detail = "thinking…") {
  const lane = state.lanes[source];
  lane.busy = true;
  lane.detail = detail;
  lane.at = Date.now();
  emit();
}

// Mark a lane idle (turn/phase ended) without clearing which model was last used.
export function setIdle(source: HudSource, detail = "") {
  const lane = state.lanes[source];
  lane.busy = false;
  if (detail) lane.detail = detail;
  lane.at = Date.now();
  emit();
}

// Append a free-form routing line to the shared log feed.
export function logRoute(source: HudSource, msg: string) {
  state.log.push({ id: logSeq++, source, msg, at: Date.now() });
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
  emit();
}

export function clearHudLog() {
  state.log = [];
  emit();
}

export function setHudHidden(hidden: boolean) {
  state.hidden = hidden;
  try {
    localStorage.setItem(HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    /* ignore */
  }
  emit();
}

export function setHudPos(x: number, y: number) {
  state.pos = { x, y };
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(state.pos));
  } catch {
    /* ignore */
  }
  // No emit here: dragging updates the DOM directly for smoothness; the value is
  // persisted so the next mount restores it.
}
