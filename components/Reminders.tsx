"use client";

import { useEffect, useRef, useState } from "react";
import { expandEvents, type BaseEvent } from "@/lib/recur";

type Task = {
  id: string;
  title: string;
  dueDate: string | null;
  done: boolean;
};

const LEAD_MS = 10 * 60 * 1000; // notify when something is within 10 minutes
const STORE_KEY = "fired-reminders";

function loadFired(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORE_KEY) || "[]"));
  } catch {
    return new Set();
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
        JSON.stringify([...firedRef.current].slice(-200))
      );
      new Notification(title, { body });
    };

    const check = () => {
      const now = new Date();
      const soon = new Date(now.getTime() + LEAD_MS);

      for (const occ of expandEvents(events, now, soon)) {
        const start = new Date(occ.startTime);
        const mins = Math.max(0, Math.round((start.getTime() - now.getTime()) / 60000));
        fire(
          `ev:${occ.occurrenceId}`,
          `Upcoming: ${occ.title}`,
          mins <= 0 ? "Starting now" : `Starts in ${mins} min`
        );
      }

      for (const t of tasks) {
        if (!t.dueDate || t.done) continue;
        const due = new Date(t.dueDate);
        if (due >= now && due <= soon) {
          fire(`task:${t.id}:${t.dueDate}`, `Task due: ${t.title}`, "Due soon");
        }
      }
    };

    check();
    const id = setInterval(check, 30 * 1000);
    return () => clearInterval(id);
  }, [perm, events, tasks]);

  if (perm === "granted") return null;

  return (
    <div className="mb-6 flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-2 text-sm">
      <span className="text-neutral-400">
        Enable reminders to get notified before events and due tasks.
      </span>
      <button
        onClick={async () => {
          if (typeof Notification === "undefined") return;
          setPerm(await Notification.requestPermission());
        }}
        className="rounded-lg bg-indigo-600 px-3 py-1.5 hover:bg-indigo-500"
      >
        Enable
      </button>
    </div>
  );
}
