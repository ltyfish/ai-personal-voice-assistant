"use client";

import { useEffect, useState } from "react";
import type { OrbState } from "@/components/jarvis/SwirlOrb";
import { getOrbState, subscribeOrbState } from "@/lib/orb-state";

/**
 * Fixed top-left "Systems online" status — mounted at the app root so it stays
 * put across every tab. Reads the global orb state published by VoiceButton.
 */
export default function StatusIndicator() {
  const [s, setS] = useState<OrbState>(getOrbState());
  useEffect(() => subscribeOrbState(setS), []);

  const on = s !== "st-standby";
  const label =
    s === "st-recording" ? "Listening"
    : s === "st-thinking" ? "Thinking"
    : s === "st-confirming" ? "Confirm"
    : on ? "Systems online"
    : "Standby";

  return (
    <div className="jarvis-status-fixed">
      <span className={`jarvis-status-dot ${on ? "on" : ""}`} />
      {label}
    </div>
  );
}
