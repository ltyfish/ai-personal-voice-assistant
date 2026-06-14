"use client";

import { useEffect, useRef, useState } from "react";
import SwirlOrb, { type OrbState } from "@/components/jarvis/SwirlOrb";
import { getOrbState, subscribeOrbState } from "@/lib/orb-state";

/**
 * Persistent left-edge orb shown on every non-JARVIS tab. Mirrors the live voice
 * state; click it to jump back to the JARVIS tab; drag it anywhere you like.
 */
export default function MiniOrb() {
  const [state, setState] = useState<OrbState>(getOrbState());
  useEffect(() => subscribeOrbState(setState), []);

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const onDown = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    drag.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) d.moved = true;
    if (d.moved) setPos({ x: d.ox + dx, y: d.oy + dy });
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) {
      window.dispatchEvent(new CustomEvent("jarvis-nav", { detail: "assistant" }));
    }
  };

  const active = state !== "st-standby";
  const label =
    state === "st-recording" ? "Listening"
    : state === "st-thinking" ? "Thinking"
    : state === "st-confirming" ? "Confirm?"
    : state === "st-listening" ? "Online"
    : "";

  return (
    <div
      className={`mini-orb${active ? " active" : ""}${pos ? " dragged" : ""}`}
      ref={ref}
      style={pos ? { left: pos.x, top: pos.y, transform: "none" } : undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      title="Back to JARVIS — drag to move"
    >
      <div className="mini-orb-core">
        <SwirlOrb state={state} variant="mini" />
      </div>
      {active && label && <span className="mini-orb-label">{label}</span>}
    </div>
  );
}
