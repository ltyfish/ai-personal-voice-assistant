"use client";

import { useCallback, useEffect, useState } from "react";
import VoiceButton from "@/components/VoiceButton";

type Task = {
  id: string;
  title: string;
  notes: string | null;
  done: boolean;
  priority: "low" | "medium" | "high";
  dueDate: string | null;
};
type Event = {
  id: string;
  title: string;
  location: string | null;
  startTime: string;
  endTime: string;
};
type Note = {
  id: string;
  title: string | null;
  body: string;
  updatedAt: string;
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";

export default function Home() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);

  const refresh = useCallback(async () => {
    const [t, e, n] = await Promise.all([
      fetch("/api/tasks").then((r) => r.json()),
      fetch("/api/events").then((r) => r.json()),
      fetch("/api/notes").then((r) => r.json()),
    ]);
    setTasks(t);
    setEvents(e);
    setNotes(n);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-8 text-center">
        <h1 className="text-3xl font-bold">Personal AI</h1>
        <p className="text-neutral-400">Your tasks, calendar and notes — by voice or by hand.</p>
      </header>

      <section className="mb-10 rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
        <VoiceButton onDone={refresh} />
      </section>

      <div className="grid gap-6 md:grid-cols-3">
        <TasksPanel tasks={tasks} refresh={refresh} />
        <CalendarPanel events={events} refresh={refresh} />
        <NotesPanel notes={notes} refresh={refresh} />
      </div>
    </main>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-4">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function TasksPanel({ tasks, refresh }: { tasks: Task[]; refresh: () => void }) {
  const [title, setTitle] = useState("");

  const add = async () => {
    if (!title.trim()) return;
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    setTitle("");
    refresh();
  };
  const toggle = async (t: Task) => {
    await fetch(`/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: !t.done }),
    });
    refresh();
  };
  const del = async (id: string) => {
    await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    refresh();
  };

  return (
    <Panel title="Tasks">
      <div className="mb-3 flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="New task…"
          className="flex-1 rounded-lg bg-neutral-800 px-3 py-1.5 text-sm outline-none"
        />
        <button onClick={add} className="rounded-lg bg-indigo-600 px-3 text-sm hover:bg-indigo-500">
          Add
        </button>
      </div>
      <ul className="space-y-2">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
            <span className={t.done ? "flex-1 text-neutral-500 line-through" : "flex-1"}>
              {t.title}
              {t.dueDate && <span className="ml-1 text-xs text-neutral-500">· {fmt(t.dueDate)}</span>}
            </span>
            <button onClick={() => del(t.id)} className="text-neutral-600 hover:text-red-400">
              ✕
            </button>
          </li>
        ))}
        {tasks.length === 0 && <li className="text-sm text-neutral-500">No tasks.</li>}
      </ul>
    </Panel>
  );
}

function CalendarPanel({ events, refresh }: { events: Event[]; refresh: () => void }) {
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const add = async () => {
    if (!title.trim() || !start || !end) return;
    await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        startTime: new Date(start).toISOString(),
        endTime: new Date(end).toISOString(),
      }),
    });
    setTitle("");
    setStart("");
    setEnd("");
    refresh();
  };
  const del = async (id: string) => {
    await fetch(`/api/events/${id}`, { method: "DELETE" });
    refresh();
  };

  return (
    <Panel title="Calendar">
      <div className="mb-3 space-y-1">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Event title…"
          className="w-full rounded-lg bg-neutral-800 px-3 py-1.5 text-sm outline-none"
        />
        <input
          type="datetime-local"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="w-full rounded-lg bg-neutral-800 px-3 py-1.5 text-sm outline-none"
        />
        <input
          type="datetime-local"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          className="w-full rounded-lg bg-neutral-800 px-3 py-1.5 text-sm outline-none"
        />
        <button onClick={add} className="w-full rounded-lg bg-indigo-600 px-3 py-1.5 text-sm hover:bg-indigo-500">
          Add event
        </button>
      </div>
      <ul className="space-y-2">
        {events.map((ev) => (
          <li key={ev.id} className="flex items-start gap-2 text-sm">
            <div className="flex-1">
              <div>{ev.title}</div>
              <div className="text-xs text-neutral-500">
                {fmt(ev.startTime)} → {new Date(ev.endTime).toLocaleTimeString([], { timeStyle: "short" })}
              </div>
            </div>
            <button onClick={() => del(ev.id)} className="text-neutral-600 hover:text-red-400">
              ✕
            </button>
          </li>
        ))}
        {events.length === 0 && <li className="text-sm text-neutral-500">No events.</li>}
      </ul>
    </Panel>
  );
}

function NotesPanel({ notes, refresh }: { notes: Note[]; refresh: () => void }) {
  const [body, setBody] = useState("");

  const add = async () => {
    if (!body.trim()) return;
    await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    setBody("");
    refresh();
  };
  const save = async (id: string, value: string) => {
    await fetch(`/api/notes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: value }),
    });
    refresh();
  };
  const del = async (id: string) => {
    await fetch(`/api/notes/${id}`, { method: "DELETE" });
    refresh();
  };

  return (
    <Panel title="Notes">
      <div className="mb-3">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="New note…"
          rows={2}
          className="w-full rounded-lg bg-neutral-800 px-3 py-1.5 text-sm outline-none"
        />
        <button onClick={add} className="mt-1 w-full rounded-lg bg-indigo-600 px-3 py-1.5 text-sm hover:bg-indigo-500">
          Add note
        </button>
      </div>
      <ul className="space-y-2">
        {notes.map((n) => (
          <li key={n.id} className="flex items-start gap-2 text-sm">
            <textarea
              defaultValue={n.body}
              onBlur={(e) => e.target.value !== n.body && save(n.id, e.target.value)}
              rows={2}
              className="flex-1 rounded-lg bg-neutral-800 px-3 py-1.5 text-sm outline-none"
            />
            <button onClick={() => del(n.id)} className="text-neutral-600 hover:text-red-400">
              ✕
            </button>
          </li>
        ))}
        {notes.length === 0 && <li className="text-sm text-neutral-500">No notes.</li>}
      </ul>
    </Panel>
  );
}
