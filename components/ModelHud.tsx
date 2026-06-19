"use client";

// Floating, draggable, RESIZABLE "current model" sticky pad. Mounted ONCE at the
// app root so it survives tab switches (position: fixed, outside the per-tab
// views). It shows the model each surface (JARVIS voice + Pipeline) is currently
// using, plus a LIVE ROTATION feed — every model pick the rotating /v1 proxy
// makes, with the key it used and the tokens it spent. Every model call (voice,
// Pipeline, and Hermes — its provider points at /api/v1) flows through that
// proxy, so a single Hermes turn shows each rotating model + its per-request
// tokens here, not just the final aggregate. Drag by the header, resize by the
// bottom-right grip, collapse, or hide; position + size persist in localStorage.

import { useEffect, useRef, useState } from "react";
import {
  subscribeHud,
  setHudHidden,
  setHudPos,
  getHudState,
  loadHudSize,
  saveHudSize,
  HUD_SIZE,
  type HudState,
} from "@/lib/model-hud";

const short = (m: string) =>
  (m || "").replace(/^openai\//, "").replace(/^local:/, "").replace(/:free$/, "");

const SOURCE_LABEL: Record<string, string> = { jarvis: "JARVIS", pipeline: "PIPELINE" };

// ── Live router feed (mirrors components/RouterFeed.tsx, compacted for the pad) ──
type RouterEvent = {
  id: number;
  at: number;
  kind: "served" | "tokens" | "cooldown" | "nokeys" | "client_error";
  model: string;
  key?: string;
  status?: number;
  prompt?: number;
  completion?: number;
  total?: number;
  detail?: string;
};
type Row = {
  id: number;
  at: number;
  kind: RouterEvent["kind"];
  model: string;
  key?: string;
  detail?: string;
  prompt?: number;
  completion?: number;
  total?: number;
};
const MAX_ROWS = 120;
const fmtTok = (n?: number) =>
  n == null ? "" : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false });
const KIND_META: Record<RouterEvent["kind"], { icon: string; color: string }> = {
  served: { icon: "▸", color: "var(--a)" },
  tokens: { icon: "↳", color: "var(--a)" },
  cooldown: { icon: "⏭", color: "#f59e0b" },
  nokeys: { icon: "⚠", color: "#e77" },
  client_error: { icon: "✕", color: "#e77" },
};

function ago(at: number, now: number): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

export default function ModelHud() {
  const [state, setState] = useState<HudState>(getHudState());
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [size, setSize] = useState<{ w: number; h: number }>(() => loadHudSize());
  const padRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const resizing = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  // On phones the free-floating, draggable, fixed-size pad covers the whole
  // screen (it can't be dragged off-canvas reliably and ignores viewport width).
  // Below this width we dock it as a bottom sheet: full-width, capped height, no
  // drag/resize, collapsed by default so it never hides the orb.
  const [mobile, setMobile] = useState(false);
  // Once the user drags the mobile dock, it becomes a free-floating pad (like
  // desktop) instead of the docked bottom sheet.
  const [mobileFloat, setMobileFloat] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  // Collapse to the slim header the first time we enter mobile, so it opens as an
  // unobtrusive bar the user can tap to expand — not a full-screen overlay.
  const didMobileCollapse = useRef(false);
  useEffect(() => {
    if (mobile && !didMobileCollapse.current) {
      didMobileCollapse.current = true;
      setCollapsed(true);
    }
  }, [mobile]);

  // Live rotation feed (per-model token usage as the proxy rotates).
  const [rows, setRows] = useState<Row[]>([]);
  const [paused, setPaused] = useState(false);
  const sinceRef = useRef(0);
  // Events with id <= this are discarded — set on clear so an in-flight poll
  // (started before the clear, returning pre-clear events) can't re-populate the
  // feed after we've emptied it.
  const minIdRef = useRef(0);
  const pausedRef = useRef(false);
  // Bumped on every clear. A poll that started before a clear sees its captured
  // token differ from the current one and discards its (now stale) events, so an
  // in-flight fetch can't repopulate the feed after we've emptied it.
  const genRef = useRef(0);
  // True while a clear's DELETE is in flight — blocks new polls during that window
  // so none fire with the pre-clear `since` and re-fetch the events being deleted.
  const clearingRef = useRef(false);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => subscribeHud(setState), []);

  // Tick so "Xs ago" stays live without re-publishing.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Poll the router feed every second and fold events into display rows.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function tick() {
      if (!stop && !pausedRef.current && !clearingRef.current) {
        const myGen = genRef.current;
        try {
          const res = await fetch(`/api/router-feed?since=${sinceRef.current}`, { cache: "no-store" });
          const data = await res.json();
          // A clear happened while this poll was in flight — its events predate the
          // clear, so drop them instead of repopulating the just-emptied feed.
          if (myGen !== genRef.current) throw new Error("stale");
          const events: RouterEvent[] = Array.isArray(data?.events) ? data.events : [];
          if (typeof data?.lastId === "number") sinceRef.current = data.lastId;
          if (events.length) applyEvents(events);
        } catch {
          /* transient — keep polling */
        }
      }
      if (!stop) timer = setTimeout(tick, 1000);
    }
    tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  function applyEvents(events: RouterEvent[]) {
    setRows((prev) => {
      const next = prev.slice();
      for (const e of events) {
        if (e.detail === "warmup") continue;
        if (e.id <= minIdRef.current) continue; // dropped by a clear
        if (e.kind === "tokens") {
          const idx = findPendingServed(next, e.model, e.key);
          if (idx >= 0) {
            next[idx] = { ...next[idx], prompt: e.prompt, completion: e.completion, total: e.total };
            continue;
          }
          next.push({ id: e.id, at: e.at, kind: "tokens", model: e.model, key: e.key, prompt: e.prompt, completion: e.completion, total: e.total });
          continue;
        }
        next.push({ id: e.id, at: e.at, kind: e.kind, model: e.model, key: e.key, detail: e.detail });
      }
      return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
    });
  }
  function findPendingServed(list: Row[], model: string, key?: string): number {
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (r.kind === "served" && r.model === model && r.key === key && r.total == null) return i;
    }
    return -1;
  }

  async function clearFeed() {
    // Invalidate any in-flight poll (genRef) and block new polls (clearingRef) so
    // nothing can repopulate the feed while we clear it on the server.
    genRef.current++;
    clearingRef.current = true;
    minIdRef.current = sinceRef.current;
    setRows([]);
    try {
      const res = await fetch(`/api/router-feed`, { method: "DELETE", cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (typeof data?.lastId === "number") {
        sinceRef.current = data.lastId;
        minIdRef.current = data.lastId;
      }
    } catch {
      /* local clear already happened */
    } finally {
      // Bump again so a poll that slipped out between the two awaits is also voided,
      // then re-enable polling from the new (post-clear) baseline.
      genRef.current++;
      clearingRef.current = false;
    }
  }

  // Pointer-drag the pad by its header; persist the final position. Pointer
  // events cover touch, so this works on phones too — the first drag pops the
  // mobile dock out of its bottom-sheet into a free-floating pad.
  const onPointerDown = (e: React.PointerEvent) => {
    const el = padRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (mobile && !mobileFloat) {
      // Start the float exactly where the docked sheet was, so it doesn't jump.
      setHudPos(rect.left, rect.top);
      setMobileFloat(true);
    }
    el.style.right = "";
    el.style.bottom = "";
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const el = padRef.current;
    if (!drag.current || !el) return;
    const x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.current.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - drag.current.dy));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const el = padRef.current;
    if (drag.current && el) {
      setHudPos(parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0);
    }
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  // Pointer-resize from the bottom-right grip; clamp to bounds, persist on release.
  const onResizeDown = (e: React.PointerEvent) => {
    if (mobile) return; // docked bottom sheet — fixed size
    e.stopPropagation();
    resizing.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizing.current;
    if (!r) return;
    const w = Math.min(HUD_SIZE.maxW, Math.max(HUD_SIZE.minW, r.w + (e.clientX - r.x)));
    const h = Math.min(HUD_SIZE.maxH, Math.max(HUD_SIZE.minH, r.h + (e.clientY - r.y)));
    setSize({ w, h });
  };
  const onResizeUp = (e: React.PointerEvent) => {
    if (resizing.current) saveHudSize(size.w, size.h);
    resizing.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const accent = "var(--a)";
  const lanes: ("jarvis" | "pipeline")[] = ["jarvis", "pipeline"];

  // The lane model is published by the client only when a turn RESPONSE returns
  // (VoiceButton → publishModel). If a turn is slow or the request times out
  // (504), the lane keeps showing "idle" even though the server is actively
  // rotating models. The LIVE ROTATION feed is server-fed and independent, so
  // fall back to the most-recent served model from it while a lane is busy.
  const liveModel = (() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].kind === "served" || rows[i].kind === "tokens") return rows[i].model;
    }
    return "";
  })();

  // Hidden → a tiny re-open chip in the corner.
  if (state.hidden) {
    return (
      <button
        onClick={() => setHudHidden(false)}
        title="Show model HUD"
        style={{
          position: "fixed",
          right: 16,
          bottom: 16,
          zIndex: 9000,
          background: "var(--card, #0d1b24)",
          color: accent,
          border: `1px solid ${accent}`,
          borderRadius: 20,
          padding: "6px 12px",
          fontSize: 12,
          fontWeight: 700,
          cursor: "pointer",
          letterSpacing: 0.5,
        }}
      >
        ⚙ MODELS
      </button>
    );
  }

  const feed = rows.slice().reverse();

  const containerStyle: React.CSSProperties = mobile && !mobileFloat
    ? {
        // Docked bottom sheet: spans the screen width, sits above the safe-area
        // inset, height grows with content up to ~55vh so it never blankets the
        // page or covers the orb when collapsed.
        position: "fixed",
        left: 8,
        right: 8,
        bottom: "calc(8px + env(safe-area-inset-bottom, 0px))",
        zIndex: 9000,
        maxHeight: "55vh",
        height: collapsed ? undefined : "auto",
        display: "flex",
        flexDirection: "column",
        background: "var(--card, #0d1b24)",
        border: `1px solid ${accent}55`,
        borderRadius: 14,
        boxShadow: "0 -8px 28px rgba(0,0,0,0.5)",
        color: "var(--text, #cfe9e6)",
        fontSize: 12,
        userSelect: "none",
        overflow: "hidden",
        backdropFilter: "blur(8px)",
      }
    : {
        position: "fixed",
        left: state.pos.x,
        top: state.pos.y,
        zIndex: 9000,
        width: mobile ? "min(92vw, 340px)" : size.w,
        height: collapsed ? undefined : mobile ? "min(60vh, 440px)" : size.h,
        maxWidth: "calc(100vw - 16px)",
        display: "flex",
        flexDirection: "column",
        background: "var(--card, #0d1b24)",
        border: `1px solid ${accent}55`,
        borderRadius: 10,
        boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
        color: "var(--text, #cfe9e6)",
        fontSize: 12,
        userSelect: "none",
        overflow: "hidden",
        backdropFilter: "blur(4px)",
      };

  return (
    <div ref={padRef} style={containerStyle}>
      {/* Header — drag handle + controls */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          cursor: "grab",
          touchAction: "none",
          background: `${accent}14`,
          borderBottom: `1px solid ${accent}33`,
          flexShrink: 0,
        }}
      >
        <span style={{ color: accent }}>⠿</span>
        <strong style={{ flex: 1, letterSpacing: 0.6, color: accent, fontSize: 11 }}>
          MODEL ROUTING
        </strong>
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Expand" : "Collapse"}
          style={btnStyle(accent)}
        >
          {collapsed ? "▢" : "—"}
        </button>
        <button onClick={() => setHudHidden(true)} title="Hide" style={btnStyle(accent)}>
          ✕
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Current-model lanes */}
          <div style={{ padding: 8, display: "grid", gap: 6, flexShrink: 0 }}>
            {lanes.map((src) => {
              const lane = state.lanes[src];
              // While the JARVIS lane is working but hasn't been told its model
              // yet, borrow the live rotation's current model so the pad never
              // shows a bare "idle" mid-turn.
              const shownModel =
                lane.model || (src === "jarvis" && lane.busy ? liveModel : "");
              return (
                <div
                  key={src}
                  style={{
                    border: `1px solid ${lane.busy ? accent : "var(--border,#23323a)"}`,
                    borderRadius: 7,
                    padding: "6px 8px",
                    background: lane.busy ? `${accent}10` : "transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: lane.busy ? accent : "var(--border,#445)",
                        boxShadow: lane.busy ? `0 0 6px ${accent}` : "none",
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontSize: 9.5, opacity: 0.7, letterSpacing: 0.5 }}>
                      {SOURCE_LABEL[src]}
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: 9, opacity: 0.5 }}>
                      {ago(lane.at, now)}
                    </span>
                  </div>
                  <div
                    style={{
                      fontWeight: 700,
                      fontSize: 12.5,
                      marginTop: 2,
                      color: shownModel ? "var(--text,#cfe9e6)" : "var(--border,#556)",
                      wordBreak: "break-all",
                    }}
                  >
                    {shownModel ? short(shownModel) : "idle"}
                  </div>
                  {lane.detail && (
                    <div style={{ fontSize: 10, opacity: 0.65, marginTop: 1 }}>{lane.detail}</div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Live rotation feed header */}
          <div
            style={{
              borderTop: `1px solid ${accent}22`,
              padding: "5px 8px 4px",
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 9.5, opacity: 0.6, letterSpacing: 0.5 }}>LIVE ROTATION</span>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: paused ? "#667" : accent,
                boxShadow: paused ? "none" : `0 0 5px ${accent}`,
              }}
            />
            <span style={{ marginLeft: "auto", fontSize: 9, opacity: 0.45 }}>{rows.length}</span>
            <button onClick={() => setPaused((p) => !p)} title={paused ? "Resume" : "Pause"} style={btnStyle(accent)}>
              {paused ? "▶" : "❚❚"}
            </button>
            <button onClick={clearFeed} title="Clear" style={btnStyle(accent)}>
              clear
            </button>
          </div>

          {/* Live rotation feed — grows to fill the resized pad */}
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              padding: "0 8px 8px",
              fontFamily: "var(--mono, ui-monospace, monospace)",
              fontSize: 10.5,
              lineHeight: 1.6,
            }}
          >
            {feed.length === 0 ? (
              <div style={{ opacity: 0.4 }}>No routing yet — run a voice turn, a pipeline, or a Hermes turn.</div>
            ) : (
              feed.map((r) => {
                const meta = KIND_META[r.kind];
                return (
                  <div key={r.id} style={{ display: "flex", gap: 6, alignItems: "baseline", whiteSpace: "nowrap" }}>
                    <span style={{ opacity: 0.4, fontSize: 9 }}>{clock(r.at)}</span>
                    <span style={{ color: meta.color, flexShrink: 0 }}>{meta.icon}</span>
                    <span
                      style={{
                        color: "var(--text, #cfe9e6)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {short(r.model)}
                    </span>
                    {r.key && <span style={{ opacity: 0.4, fontSize: 9.5 }}>·{r.key.slice(0, 4)}</span>}
                    {r.total != null ? (
                      <span style={{ marginLeft: "auto", color: accent, flexShrink: 0 }}>
                        {fmtTok(r.total)} tok
                      </span>
                    ) : r.detail ? (
                      <span style={{ marginLeft: "auto", color: meta.color, opacity: 0.85, flexShrink: 0, fontSize: 9.5 }}>
                        {r.detail}
                      </span>
                    ) : (
                      <span style={{ marginLeft: "auto", opacity: 0.4, flexShrink: 0, fontSize: 9.5 }}>…</span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Resize grip (bottom-right) */}
          <div
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            title="Drag to resize"
            style={{
              display: mobile ? "none" : "block",
              position: "absolute",
              right: 0,
              bottom: 0,
              width: 16,
              height: 16,
              cursor: "nwse-resize",
              background: `linear-gradient(135deg, transparent 50%, ${accent}88 50%)`,
              borderBottomRightRadius: 10,
            }}
          />
        </>
      )}
    </div>
  );
}

function btnStyle(accent: string): React.CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: accent,
    cursor: "pointer",
    fontSize: 11,
    padding: "0 3px",
    lineHeight: 1,
    opacity: 0.8,
  };
}
