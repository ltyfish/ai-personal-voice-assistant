"use client";

import { useEffect, useRef, useState } from "react";
import { expandEvents, type BaseEvent } from "@/lib/recur";

type Task = {
  id: string;
  title: string;
  dueDate: string | null;
  done: boolean;
};

const LEAD_MS = 10 * 60 * 1000; // heads-up this far before something is due
const GRACE_MS = 5 * 60 * 1000; // still alert if we open the app shortly after
const STORE_KEY = "fired-reminders";

function loadFired(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORE_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

// Short two-tone chime via WebAudio so the reminder is noticeable even if the
// OS notification is silent.
function chime() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    const beep = (freq: number, start: number, dur: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = freq;
      o.type = "sine";
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
      o.start(ctx.currentTime + start);
      o.stop(ctx.currentTime + start + dur);
    };
    beep(880, 0, 0.18);
    beep(1175, 0.18, 0.22);
    setTimeout(() => ctx.close().catch(() => {}), 800);
  } catch {
    /* audio unavailable — the OS notification still shows */
  }
}

function speak(text: string) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    const v = window.speechSynthesis
      .getVoices()
      .find((x) => x.voiceURI === (localStorage.getItem("tts.voice") || ""));
    if (v) u.voice = v;
    window.speechSynthesis.speak(u);
  } catch {
    /* TTS unavailable — ignore */
  }
}

export default function Reminders({
  events,
  tasks,
}: {
  events: BaseEvent[];
  tasks: Task[];
}) {
  const [perm, setPerm] = useState<NotificationPermission>("default");
  const firedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (typeof Notification !== "undefined") setPerm(Notification.permission);
    firedRef.current = loadFired();
  }, []);

  useEffect(() => {
    if (perm !== "granted") return;

    const fire = (key: string, title: string, body: string) => {
      if (firedRef.current.has(key)) return;
      firedRef.current.add(key);
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify([...firedRef.current].slice(-300))
      );
      try {
        new Notification(title, { body });
      } catch {
        /* notification blocked — chime + speech still play */
      }
      chime();
      speak(`${title}. ${body}`);
    };

    const check = () => {
      const now = Date.now();
      // Window spans a little before now (so a just-started item still alerts if
      // we just opened the app) through the lead horizon.
      const from = new Date(now - GRACE_MS);
      const to = new Date(now + LEAD_MS);

      for (const occ of expandEvents(events, from, to)) {
        const start = new Date(occ.startTime).getTime();
        const diff = start - now;
        if (diff > 0) {
          const mins = Math.max(1, Math.round(diff / 60000));
          fire(`ev-lead:${occ.occurrenceId}`, `Upcoming: ${occ.title}`, `Starts in ${mins} min`);
        } else if (diff > -GRACE_MS) {
          fire(`ev-start:${occ.occurrenceId}`, `Now: ${occ.title}`, "Starting now");
        }
      }

      for (const t of tasks) {
        if (!t.dueDate || t.done) continue;
        const diff = new Date(t.dueDate).getTime() - now;
        if (diff > 0 && diff <= LEAD_MS) {
          fire(`task-lead:${t.id}:${t.dueDate}`, `Task due soon: ${t.title}`, "Due in a few minutes");
        } else if (diff <= 0 && diff > -GRACE_MS) {
          fire(`task-due:${t.id}:${t.dueDate}`, `Task due: ${t.title}`, "Due now");
        }
      }
    };

    check();
    const id = setInterval(check, 30 * 1000);
    return () => clearInterval(id);
  }, [perm, events, tasks]);

  if (perm === "granted") return null;

  // Floating prompt (the component is mounted app-wide now, so don't disturb
  // page layout — sit it top-center as a small toast until enabled).
  return (
    <div className="reminders-cta">
      <span>🔔 Enable reminders to get notified before events &amp; due tasks.</span>
      <button
        onClick={async () => {
          if (typeof Notification === "undefined") return;
          setPerm(await Notification.requestPermission());
        }}
      >
        Enable
      </button>
    </div>
  );
}
