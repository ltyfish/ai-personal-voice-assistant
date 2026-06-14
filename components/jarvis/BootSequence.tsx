"use client";

import { useEffect, useRef, useState } from "react";

/**
 * J.A.R.V.I.S. power-on overlay. Rings spin up, a column of boot lines types
 * out, then the whole thing fades to reveal the app. Shown once per browser
 * session (sessionStorage) so tab-switches and reloads-within-a-session don't
 * replay it. Honours prefers-reduced-motion by skipping straight through.
 */

const BOOT_LINES = [
  "INITIALIZING ARC REACTOR…",
  "MOUNTING NEURAL CORE…",
  "CALIBRATING HUD INTERFACE…",
  "LINKING VOICE ENGINE…",
  "LOADING USER PROTOCOLS…",
  "SECURE CHANNEL ESTABLISHED",
  "ALL SYSTEMS ONLINE",
];

export default function BootSequence() {
  const [show, setShow] = useState(false);
  const [lineCount, setLineCount] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Already played this session → don't show. The flag is set only when the
    // sequence COMPLETES (below), not here — otherwise React 18 StrictMode's
    // double-invoke (run → cleanup clears timers → run) would set the flag on
    // the first run, make the second run bail early, and strand the overlay
    // visible forever with no timers left to hide it.
    if (sessionStorage.getItem("jarvis.booted") === "1") return;

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    setShow(true);
    timers.current = [];

    const push = (fn: () => void, ms: number) =>
      timers.current.push(setTimeout(fn, reduced ? Math.min(ms, 200) : ms));

    // type the boot lines out one at a time
    BOOT_LINES.forEach((_, i) => push(() => setLineCount(i + 1), 260 + i * 300));

    const total = reduced ? 400 : 260 + BOOT_LINES.length * 300 + 700;
    push(() => setLeaving(true), total);
    push(() => {
      setShow(false);
      sessionStorage.setItem("jarvis.booted", "1");
    }, total + 650);

    return () => timers.current.forEach(clearTimeout);
  }, []);

  if (!show) return null;

  return (
    <div className={`jarvis-boot${leaving ? " leaving" : ""}`} role="presentation">
      <div className="boot-rings" aria-hidden>
        <span className="boot-ring r1" />
        <span className="boot-ring r2" />
        <span className="boot-ring r3" />
        <span className="boot-core" />
      </div>
      <div className="boot-title">J.A.R.V.I.S.</div>
      <div className="boot-tag">JUST A RATHER VERY INTELLIGENT SYSTEM</div>
      <ul className="boot-log">
        {BOOT_LINES.slice(0, lineCount).map((l, i) => (
          <li key={i} className={i === BOOT_LINES.length - 1 ? "ok" : ""}>
            <span className="boot-caret">›</span> {l}
          </li>
        ))}
      </ul>
    </div>
  );
}
