"use client";

import { useEffect, useRef } from "react";

/**
 * J.A.R.V.I.S. orb — black-&-white energy field.
 *
 *  • variant "stage": a DNA-like double-helix energy stream that spans the full
 *    width of the screen, pinching into a large luminous particle sphere dead
 *    centre, with motion streaks flying outward. "J.A.R.V.I.S." rides on top.
 *  • variant "mini": just the particle sphere — used by the persistent left-edge
 *    orb on every other tab so it mirrors the same look + live voice state.
 *
 * Canvas-2D, no deps. Monochrome (white on black). Optimised: sphere points +
 * filament edges are precomputed once; the hot loop only rotates/projects and
 * walks fixed pools (no allocation, no per-line shadowBlur); DPR is capped; a
 * fading trail does the bloom/smear; pauses for prefers-reduced-motion. State
 * changes speed / energy / brightness only — the palette stays black & white.
 */

export type OrbState =
  | "st-standby"
  | "st-listening"
  | "st-recording"
  | "st-thinking"
  | "st-confirming";

type Variant = "stage" | "mini";

const STYLE: Record<OrbState, { spd: number; energy: number; bright: number }> = {
  "st-standby":    { spd: 0.28, energy: 0.12, bright: 0.55 },
  "st-listening":  { spd: 0.65, energy: 0.32, bright: 0.82 },
  "st-recording":  { spd: 1.55, energy: 0.72, bright: 1.0  },
  "st-thinking":   { spd: 1.30, energy: 0.55, bright: 0.95 },
  "st-confirming": { spd: 0.72, energy: 0.36, bright: 0.86 },
};

type P3 = { x: number; y: number; z: number };

function fibSphere(n: number): P3[] {
  const pts: P3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const t = golden * i;
    pts.push({ x: Math.cos(t) * r, y, z: Math.sin(t) * r });
  }
  return pts;
}

function buildEdges(pts: P3[], maxEdges: number, maxDist: number): [number, number][] {
  const edges: [number, number][] = [];
  const d2 = maxDist * maxDist;
  for (let i = 0; i < pts.length && edges.length < maxEdges; i++) {
    for (let j = i + 1; j < pts.length && edges.length < maxEdges; j++) {
      const dx = pts[i].x - pts[j].x;
      const dy = pts[i].y - pts[j].y;
      const dz = pts[i].z - pts[j].z;
      if (dx * dx + dy * dy + dz * dz < d2) edges.push([i, j]);
    }
  }
  return edges;
}

type Streak = { x: number; y: number; vx: number; len: number; a: number };

export default function SwirlOrb({
  state,
  variant = "stage",
}: {
  state: OrbState;
  variant?: Variant;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<OrbState>(state);
  stateRef.current = state;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const isStage = variant === "stage";
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0, h = 0;

    const N = isStage ? 150 : 80;
    const pts = fibSphere(N);
    const edges = buildEdges(pts, isStage ? 200 : 120, 0.42);
    const phase = pts.map((_, i) => i * 1.7);
    const sx = new Float32Array(N);
    const sy = new Float32Array(N);
    const sz = new Float32Array(N);

    // Motion-streak pool (stage only).
    const STREAKS = isStage ? 60 : 0;
    const streaks: Streak[] = [];

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      w = r.width; h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const spawnStreak = (s: Streak) => {
      const cx = w / 2, cy = h / 2;
      const dir = Math.random() < 0.5 ? -1 : 1;
      s.x = cx + (Math.random() - 0.5) * w * 0.12;
      s.y = cy + (Math.random() - 0.5) * Math.min(h * 0.32, 200);
      s.vx = dir * (1.5 + Math.random() * 4.5);
      s.len = 8 + Math.random() * 26;
      s.a = 0.2 + Math.random() * 0.5;
    };

    let spd = STYLE[stateRef.current].spd;
    let energy = STYLE[stateRef.current].energy;
    let bright = STYLE[stateRef.current].bright;
    let ry = 0, rx = 0;
    let raf = 0;

    const drawSphere = (cx: number, cy: number, R: number, t: number) => {
      // core bloom
      const coreR = R * (0.95 + 0.06 * Math.sin(t * 1.6));
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      core.addColorStop(0, `rgba(255,255,255,${0.95 * bright})`);
      core.addColorStop(0.16, `rgba(235,240,255,${0.7 * bright})`);
      core.addColorStop(0.5, `rgba(200,210,235,${0.18 * bright})`);
      core.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      const cosY = Math.cos(ry), sinY = Math.sin(ry);
      const cosX = Math.cos(rx), sinX = Math.sin(rx);
      for (let i = 0; i < N; i++) {
        const p = pts[i];
        const j = 1 + energy * 0.16 * Math.sin(t * 3 + phase[i]);
        const x = p.x * j, y = p.y * j, z = p.z * j;
        const x1 = x * cosY - z * sinY;
        const z1 = x * sinY + z * cosY;
        const y1 = y * cosX - z1 * sinX;
        const z2 = y * sinX + z1 * cosX;
        sx[i] = cx + x1 * R;
        sy[i] = cy + y1 * R;
        sz[i] = z2;
      }

      ctx.lineWidth = 1;
      for (let e = 0; e < edges.length; e++) {
        const a = edges[e][0], b = edges[e][1];
        const da = ((sz[a] + sz[b]) * 0.5 + 1) * 0.5;
        ctx.strokeStyle = `rgba(220,228,255,${(0.04 + da * 0.14) * bright})`;
        ctx.beginPath();
        ctx.moveTo(sx[a], sy[a]);
        ctx.lineTo(sx[b], sy[b]);
        ctx.stroke();
      }

      for (let i = 0; i < N; i++) {
        const da = (sz[i] + 1) * 0.5;
        const rad = 0.6 + da * 1.9;
        const tw = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 2 + phase[i]));
        ctx.fillStyle = `rgba(230,236,255,${(0.22 + da * 0.7) * tw * bright})`;
        ctx.beginPath();
        ctx.arc(sx[i], sy[i], rad, 0, Math.PI * 2);
        ctx.fill();
        if (da > 0.82) {
          ctx.fillStyle = `rgba(255,255,255,${(da - 0.82) * 3 * tw * bright})`;
          ctx.beginPath();
          ctx.arc(sx[i], sy[i], rad * 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    const drawStream = (cx: number, cy: number, t: number) => {
      const step = 9;
      const k = 0.0135;
      const baseAmp = Math.min(h * 0.3, 270);
      const half = w / 2;

      // bright central band (horizontal energy spine)
      const band = ctx.createLinearGradient(0, 0, w, 0);
      band.addColorStop(0, "rgba(0,0,0,0)");
      band.addColorStop(0.5, `rgba(255,255,255,${0.5 * bright})`);
      band.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = band;
      const bandH = 2 + energy * 3;
      ctx.fillRect(0, cy - bandH, w, bandH * 2);

      // two helix strands rendered as granular dots + faint rungs
      for (let x = 0; x <= w; x += step) {
        const nx = Math.abs(x - cx) / half;          // 0 centre .. 1 edge
        const dx = (x - cx) / (w * 0.34);
        const env = Math.exp(-dx * dx);               // bulge at centre
        // Taper gracefully toward the edges but never vanish — the strands stay
        // faintly visible all the way out instead of cutting off abruptly.
        const edgeFade = 0.32 + 0.68 * Math.pow(1 - nx, 0.55);
        const amp = baseAmp * (0.28 + 0.72 * env) * (1 + energy * 0.6);
        const wob = Math.sin(x * 0.05 + t * 2) * energy * 6;
        const y1 = cy + (amp + wob) * Math.sin(k * x - t * spd);
        const y2 = cy + (amp + wob) * Math.sin(k * x - t * spd + Math.PI);
        const baseA = bright * edgeFade * (0.25 + 0.6 * env);

        // rung between strands (near centre only)
        if (env > 0.25 && ((x / step) | 0) % 4 === 0) {
          ctx.strokeStyle = `rgba(210,220,255,${baseA * 0.22})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, y1);
          ctx.lineTo(x, y2);
          ctx.stroke();
        }

        const r = 0.7 + env * 1.6;
        const tw1 = 0.55 + 0.45 * Math.sin(x * 0.08 + t * 4);
        const tw2 = 0.55 + 0.45 * Math.sin(x * 0.08 + t * 4 + 2.2);
        ctx.fillStyle = `rgba(235,240,255,${baseA * tw1})`;
        ctx.beginPath(); ctx.arc(x, y1, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(235,240,255,${baseA * tw2})`;
        ctx.beginPath(); ctx.arc(x, y2, r, 0, Math.PI * 2); ctx.fill();
      }

      // motion streaks flying outward
      ctx.lineWidth = 1.4;
      for (let i = 0; i < STREAKS; i++) {
        let s = streaks[i];
        if (!s) { s = { x: 0, y: 0, vx: 0, len: 0, a: 0 }; spawnStreak(s); streaks[i] = s; }
        s.x += s.vx * (0.6 + spd);
        if (s.x < -40 || s.x > w + 40) { spawnStreak(s); continue; }
        const fade = 1 - Math.abs(s.x - cx) / (half + 40);
        ctx.strokeStyle = `rgba(255,255,255,${s.a * fade * bright})`;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - Math.sign(s.vx) * s.len, s.y);
        ctx.stroke();
      }
    };

    const frame = (now: number) => {
      const s = STYLE[stateRef.current];
      spd += (s.spd - spd) * 0.06;
      energy += (s.energy - energy) * 0.06;
      bright += (s.bright - bright) * 0.06;

      const cx = w / 2, cy = h / 2;
      const t = now * 0.001;
      ry += spd * 0.012;
      rx = Math.sin(t * 0.3) * 0.35;

      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = `rgba(0,0,0,${isStage ? 0.26 : 0.22})`;
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = "lighter";
      if (isStage) {
        drawStream(cx, cy, t);
        drawSphere(cx, cy, Math.min(w, h) * 0.2 + Math.min(h * 0.13, 112), t);
      } else {
        drawSphere(cx, cy, Math.min(w, h) * 0.3, t);
      }
      ctx.globalCompositeOperation = "source-over";

      if (!reduced) raf = requestAnimationFrame(frame);
    };

    if (reduced) {
      for (let i = 0; i < 30; i++) frame(performance.now() + i * 16);
    } else {
      raf = requestAnimationFrame(frame);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [variant]);

  return (
    <canvas
      className={variant === "mini" ? "mini-orb-canvas" : "jarvis-swirl"}
      ref={ref}
      aria-hidden
    />
  );
}
