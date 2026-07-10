"use client";

import { useEffect, useRef } from "react";

export type OrbState =
  | "st-standby"
  | "st-listening"
  | "st-recording"
  | "st-thinking"
  | "st-confirming";

type Variant = "stage" | "mini";
type Point3 = { x: number; y: number; z: number; seed: number };
type Projected = { x: number; y: number; z: number; alpha: number };

const STATE: Record<OrbState, { speed: number; pulse: number; energy: number }> = {
  "st-standby": { speed: 0.12, pulse: 0.08, energy: 0.62 },
  "st-listening": { speed: 0.24, pulse: 0.16, energy: 0.68 },
  "st-recording": { speed: 0.58, pulse: 0.32, energy: 1 },
  "st-thinking": { speed: 0.76, pulse: 0.24, energy: 0.94 },
  "st-confirming": { speed: 0.3, pulse: 0.2, energy: 0.78 },
};

const TAU = Math.PI * 2;

function fibonacciShell(count: number): Point3[] {
  const points: Point3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = golden * i;
    points.push({
      x: Math.cos(angle) * radius,
      y,
      z: Math.sin(angle) * radius,
      seed: (i * 0.61803398875) % 1,
    });
  }
  return points;
}

function buildEdges(points: Point3[], limit: number): Array<[number, number]> {
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i += 1) {
    const candidates: Array<{ index: number; distance: number }> = [];
    for (let j = i + 1; j < points.length; j += 1) {
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      const dz = points[i].z - points[j].z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance < 0.44) candidates.push({ index: j, distance });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    for (const candidate of candidates.slice(0, limit)) edges.push([i, candidate.index]);
  }
  return edges;
}

export default function SwirlOrb({
  state,
  variant = "stage",
}: {
  state: OrbState;
  variant?: Variant;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const mini = variant === "mini";
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const points = fibonacciShell(mini ? 72 : 176);
    const edges = buildEdges(points, mini ? 2 : 3);
    const projected: Projected[] = points.map(() => ({ x: 0, y: 0, z: 0, alpha: 0 }));
    const drawOrder = points.map((_, index) => index);
    let width = 1;
    let height = 1;
    let frameId = 0;
    let rotation = 0;
    let tiltX = -0.16;
    let tiltY = 0;
    let targetTiltX = -0.16;
    let targetTiltY = 0;
    let speed = STATE[stateRef.current].speed;
    let energy = STATE[stateRef.current].energy;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!finePointer || reducedMotion) return;
      const bounds = canvas.getBoundingClientRect();
      const nx = (event.clientX - bounds.left) / bounds.width - 0.5;
      const ny = (event.clientY - bounds.top) / bounds.height - 0.5;
      targetTiltY = nx * 0.34;
      targetTiltX = -0.16 - ny * 0.24;
    };

    const onPointerLeave = () => {
      targetTiltX = -0.16;
      targetTiltY = 0;
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);

    const render = (time: number) => {
      const config = STATE[stateRef.current];
      speed += (config.speed - speed) * 0.035;
      energy += (config.energy - energy) * 0.045;
      tiltX += (targetTiltX - tiltX) * 0.055;
      tiltY += (targetTiltY - tiltY) * 0.055;
      if (!reducedMotion) rotation += speed * 0.006;

      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) * (mini ? 0.34 : 0.31);
      const pulse = 1 + Math.sin(time * 0.0018) * config.pulse * 0.08;
      const rotationX = tiltX + Math.sin(rotation * 0.37) * 0.08;
      const rotationY = rotation + tiltY;
      const cosY = Math.cos(rotationY);
      const sinY = Math.sin(rotationY);
      const cosX = Math.cos(rotationX);
      const sinX = Math.sin(rotationX);

      context.clearRect(0, 0, width, height);

      const aura = context.createRadialGradient(cx, cy, radius * 0.02, cx, cy, radius * 1.72);
      aura.addColorStop(0, `rgba(109, 236, 224, ${0.17 * energy})`);
      aura.addColorStop(0.38, `rgba(66, 195, 189, ${0.08 * energy})`);
      aura.addColorStop(1, "rgba(8, 11, 14, 0)");
      context.fillStyle = aura;
      context.beginPath();
      context.arc(cx, cy, radius * 1.75, 0, TAU);
      context.fill();

      for (let i = 0; i < points.length; i += 1) {
        const source = points[i];
        const breathing = 1 + Math.sin(time * 0.0014 + source.seed * TAU) * config.pulse * 0.1;
        const px = source.x * breathing;
        const py = source.y * breathing;
        const pz = source.z * breathing;
        const rotatedX = px * cosY - pz * sinY;
        const rotatedZ = px * sinY + pz * cosY;
        const rotatedY = py * cosX - rotatedZ * sinX;
        const depthZ = py * sinX + rotatedZ * cosX;
        const perspective = 2.7 / (3.25 - depthZ);
        projected[i].x = cx + rotatedX * radius * perspective * pulse;
        projected[i].y = cy + rotatedY * radius * perspective * pulse;
        projected[i].z = depthZ;
        projected[i].alpha = (0.16 + (depthZ + 1) * 0.34) * energy;
      }

      context.lineWidth = mini ? 0.65 : 0.8;
      for (const [from, to] of edges) {
        const a = projected[from];
        const b = projected[to];
        const depth = Math.max(0.22, (a.z + b.z + 2) / 4);
        context.strokeStyle = `rgba(118, 232, 222, ${0.085 * energy * depth})`;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }

      drawOrder.sort((a, b) => projected[a].z - projected[b].z);
      for (const index of drawOrder) {
        const point = projected[index];
        const depth = (point.z + 1) / 2;
        const size = (mini ? 0.7 : 0.85) + depth * (mini ? 1.35 : 1.8);
        context.fillStyle = `rgba(160, 247, 237, ${point.alpha})`;
        context.beginPath();
        context.arc(point.x, point.y, size, 0, TAU);
        context.fill();
      }

      const core = context.createRadialGradient(cx - radius * 0.08, cy - radius * 0.12, 0, cx, cy, radius * 0.48);
      core.addColorStop(0, `rgba(224, 255, 250, ${0.95 * energy})`);
      core.addColorStop(0.1, `rgba(112, 235, 224, ${0.72 * energy})`);
      core.addColorStop(0.46, `rgba(29, 125, 126, ${0.28 * energy})`);
      core.addColorStop(1, "rgba(7, 13, 16, 0)");
      context.fillStyle = core;
      context.beginPath();
      context.arc(cx, cy, radius * 0.58, 0, TAU);
      context.fill();

      if (!reducedMotion) frameId = requestAnimationFrame(render);
    };

    render(performance.now());

    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [variant]);

  return (
    <canvas
      ref={canvasRef}
      className={variant === "mini" ? "mini-orb-canvas" : "jarvis-swirl"}
      aria-hidden="true"
    />
  );
}
