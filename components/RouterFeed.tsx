"use client";

// Live router feed — the freellmapi-style "which model just ran, on which key,
// for how many tokens" stream. Polls GET /api/router-feed for events emitted by
// the rotating /v1 proxy (lib/llm-router.ts) and renders them newest-first. Every
// model call JARVIS makes — voice, Pipeline, AND Hermes (its provider points at
// /api/v1) — flows through that proxy, so this shows the real live rotation.
//
// Token counts arrive a beat after the matching "served" line (usage is parsed
// from a response clone), so a `tokens` event is stitched onto the most recent
// matching served row; if no row is waiting it stands on its own.

import { useEffect, useRef, useState } from "react";

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
const short = (m: string) =>
  (m || "").replace(/^openai\//, "").replace(/:free$/, "");
const fmtTok = (n?: number) => (n == null ? "" : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);

function clock(at: number): string {
  const d = new Date(at);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

const META: Record<RouterEvent["kind"], { icon: string; color: string }> = {
  served: { icon: "▸", color: "var(--accent, #36e0c8)" },
  tokens: { icon: "↳", color: "var(--accent, #36e0c8)" },
  cooldown: { icon: "⏭", color: "#f59e0b" },
  nokeys: { icon: "⚠", color: "#e77" },
  client_error: { icon: "✕", color: "#e77" },
};

export default function RouterFeed() {
  const [rows, setRows] = useState<Row[]>([]);
  const [live, setLive] = useState(true);
  const sinceRef = useRef(0);
  const liveRef = useRef(true);

  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (!stop && liveRef.current) {
        try {
          const res = await fetch(`/api/router-feed?since=${sinceRef.current}`, { cache: "no-store" });
          const data = await res.json();
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

  // Fold incoming events into display rows, stitching token totals onto the
  // most recent matching served row that's still waiting for them.
  function applyEvents(events: RouterEvent[]) {
    setRows((prev) => {
      const next = prev.slice();
      for (const e of events) {
        if (e.kind === "tokens") {
          const idx = findPendingServed(next, e.model, e.key);
          if (idx >= 0) {
            next[idx] = { ...next[idx], prompt: e.prompt, completion: e.completion, total: e.total };
            continue;
          }
          // No waiting row (e.g. panel opened mid-turn): show it standalone.
          next.push({ id: e.id, at: e.at, kind: "tokens", model: e.model, key: e.key, prompt: e.prompt, completion: e.completion, total: e.total });
          continue;
        }
        next.push({ id: e.id, at: e.at, kind: e.kind, model: e.model, key: e.key, detail: e.detail });
      }
      return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
    });
  }

  // Newest served row for this model+key that hasn't received tokens yet.
  function findPendingServed(list: Row[], model: string, key?: string): number {
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (r.kind === "served" && r.model === model && r.key === key && r.total == null) return i;
    }
    return -1;
  }

  async function clearFeed() {
    setRows([]);
    try {
      const res = await fetch(`/api/router-feed`, { method: "DELETE", cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (typeof data?.lastId === "number") sinceRef.current = data.lastId;
    } catch {
      /* local clear already happened */
    }
  }

  const accent = "var(--accent, #36e0c8)";
  const view = rows.slice().reverse();

  return (
    <div style={{ border: `1px solid ${accent}33`, borderRadius: 10, padding: "12px 14px", margin: "16px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <strong style={{ fontSize: 14, color: accent, letterSpacing: 0.5 }}>Live routing feed</strong>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: live ? accent : "#667", boxShadow: live ? `0 0 6px ${accent}` : "none" }} />
        <button onClick={() => setLive((v) => !v)} style={pillBtn(accent)}>
          {live ? "pause" : "resume"}
        </button>
        <button onClick={clearFeed} style={pillBtn(accent)}>clear</button>
        <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.5 }}>{rows.length} events</span>
      </div>
      <p style={{ opacity: 0.65, fontSize: 12, marginTop: 0, lineHeight: 1.5 }}>
        Every model pick the rotating proxy makes — voice, Pipeline, and Hermes — with the key it used
        and the tokens it spent. Updates live.
      </p>
      <div
        style={{
          maxHeight: 320,
          overflowY: "auto",
          fontFamily: "var(--mono, ui-monospace, monospace)",
          fontSize: 12,
          lineHeight: 1.7,
          marginTop: 6,
        }}
      >
        {view.length === 0 ? (
          <div style={{ opacity: 0.4, fontSize: 12 }}>No routing yet — run a voice turn, a pipeline, or a Hermes turn.</div>
        ) : (
          view.map((r) => {
            const meta = META[r.kind];
            return (
              <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "baseline", whiteSpace: "nowrap" }}>
                <span style={{ opacity: 0.4, fontSize: 10.5 }}>{clock(r.at)}</span>
                <span style={{ color: meta.color, flexShrink: 0 }}>{meta.icon}</span>
                <span style={{ color: "var(--text, #cfe9e6)", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {short(r.model)}
                </span>
                {r.key && <span style={{ opacity: 0.45, fontSize: 11 }}>key {r.key}</span>}
                {r.total != null ? (
                  <span style={{ marginLeft: "auto", color: accent, flexShrink: 0 }}>
                    {fmtTok(r.prompt)}+{fmtTok(r.completion)} = {fmtTok(r.total)} tok
                  </span>
                ) : r.detail ? (
                  <span style={{ marginLeft: "auto", color: meta.color, opacity: 0.85, flexShrink: 0, fontSize: 11 }}>
                    {r.detail}
                  </span>
                ) : (
                  <span style={{ marginLeft: "auto", opacity: 0.4, flexShrink: 0, fontSize: 11 }}>waiting…</span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function pillBtn(accent: string): React.CSSProperties {
  return {
    background: "transparent",
    border: `1px solid ${accent}55`,
    color: accent,
    cursor: "pointer",
    fontSize: 11,
    borderRadius: 12,
    padding: "1px 8px",
  };
}
