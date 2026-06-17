"use client";

import { useEffect, useRef, useState } from "react";
import { expandEvents, type BaseEvent } from "@/lib/recur";

type Task = {
  id: string;
  title: string;
  dueDate: string | null;
  done: boolean;
};
type Subtask = {
  id: string;
  title: string;
  dueDate: string | null;
  done: boolean;
};
type Note = {
  id: string;
  title: string | null;
  body: string;
  date: string | null;
};
// An improvement's scheduled time: legacy bare ISO start string, or {start,end?}.
type ImpTime = string | { start: string; end?: string };
type Project = {
  id: string;
  title: string;
  improvementTimes?: Record<string, ImpTime>;
  done?: boolean;
};

const impStartIso = (v: ImpTime | undefined): string =>
  typeof v === "string" ? v : v?.start ?? "";

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
  subtasks = [],
  notes = [],
  projects = [],
}: {
  events: BaseEvent[];
  tasks: Task[];
  subtasks?: Subtask[];
  notes?: Note[];
  projects?: Project[];
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

      // Anything with a single scheduled timestamp (tasks, subtasks, notes,
      // project improvement times) shares one lead/now reminder shape.
      const remindAt = (
        whenIso: string | null | undefined,
        keyBase: string,
        leadTitle: string,
        nowTitle: string
      ) => {
        if (!whenIso) return;
        const when = new Date(whenIso).getTime();
        if (Number.isNaN(when)) return;
        const diff = when - now;
        if (diff > 0 && diff <= LEAD_MS) {
          const mins = Math.max(1, Math.round(diff / 60000));
          fire(`${keyBase}:lead:${whenIso}`, leadTitle, `In ${mins} min`);
        } else if (diff <= 0 && diff > -GRACE_MS) {
          fire(`${keyBase}:now:${whenIso}`, nowTitle, "Now");
        }
      };

      for (const t of tasks) {
        if (t.done) continue;
        remindAt(t.dueDate, `task:${t.id}`, `Task due soon: ${t.title}`, `Task due: ${t.title}`);
      }

      for (const s of subtasks) {
        if (s.done) continue;
        remindAt(s.dueDate, `sub:${s.id}`, `Subtask due soon: ${s.title}`, `Subtask due: ${s.title}`);
      }

      for (const n of notes) {
        const label = (n.title || n.body || "Note").slice(0, 60);
        remindAt(n.date, `note:${n.id}`, `Note soon: ${label}`, `Note: ${label}`);
      }

      for (const p of projects) {
        if (p.done) continue;
        for (const [imp, raw] of Object.entries(p.improvementTimes ?? {})) {
          const label = `${p.title}: ${imp}`.slice(0, 70);
          remindAt(impStartIso(raw), `imp:${p.id}:${imp}`, `Upcoming — ${label}`, `Now — ${label}`);
        }
      }
    };

    check();
    const id = setInterval(check, 30 * 1000);
    return () => clearInterval(id);
  }, [perm, events, tasks, subtasks, notes, projects]);

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
