"use client";

import { useCallback, useEffect, useState } from "react";
import VoiceButton from "@/components/VoiceButton";
import MailApp from "@/components/mail/MailApp";
import { expandEvents } from "@/lib/recur";
import { refOf } from "@/lib/refs";
import Reminders from "@/components/Reminders";
import { Select, DateField } from "@/components/ui/Field";
import BootSequence from "@/components/jarvis/BootSequence";
import "./mail/mail.css";

type Task = {
  id: string;
  seq: number;
  title: string;
  notes: string | null;
  done: boolean;
  priority: "low" | "medium" | "high";
  dueDate: string | null;
};
type Recurrence = "none" | "daily" | "weekly" | "monthly";
type Event = {
  id: string;
  seq: number;
  title: string;
  location: string | null;
  done: boolean;
  startTime: string;
  endTime: string;
  recurrence: Recurrence;
  recurrenceEnd: string | null;
  projectId: string | null;
};
type Subtask = {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  priority: "low" | "medium" | "high";
  dueDate: string | null;
};
type Note = {
  id: string;
  seq: number;
  title: string | null;
  body: string;
  date: string | null;
  updatedAt: string;
};
type Project = {
  id: string;
  seq: number;
  title: string;
  improvements: string[];
  improvementTimes: Record<string, string>;
  done: boolean;
  updatedAt: string;
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";

// Speech-friendly reference shown next to each item (matches the voice agent),
// e.g. "Task 3" / "Note 4" — full words so Whisper picks them up reliably.
const taskRef = (t: Task) => refOf("task", t.seq);
const eventRef = (e: Event) => refOf("event", e.seq);
const noteRef = (n: Note) => refOf("note", n.seq);
const projectRef = (p: Project) => refOf("project", p.seq);

function RefChip({ id }: { id: string }) {
  return <span className="a-chip">{id}</span>;
}

export default function Home() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  const refresh = useCallback(async () => {
    const opts: RequestInit = { cache: "no-store" };
    const [t, e, n, p] = await Promise.all([
      fetch("/api/tasks", opts).then((r) => r.json()),
      fetch("/api/events", opts).then((r) => r.json()),
      fetch("/api/notes", opts).then((r) => r.json()),
      fetch("/api/projects", opts).then((r) => r.json()),
    ]);
    setTasks(t);
    setEvents(e);
    setNotes(n);
    setProjects(p);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Completed tasks/events live in History; the live panels show only open ones.
  const openTasks = tasks.filter((t) => !t.done);
  const openEvents = events.filter((e) => !e.done);

  // JARVIS page — full-screen voice stage, sci-fi HUD. Nothing else competes
  // with the orb here; tasks/calendar/notes each get their own modern tab.
  const assistant = (
    <div className="assistant-tab jarvis-page">
      <VoiceButton onDone={refresh} />
    </div>
  );

  const tasksTab = <TasksPanel tasks={tasks} refresh={refresh} />;

  const calendarTab = (
    <CalendarPanel events={events} tasks={tasks} notes={notes} refresh={refresh} />
  );

  const notesTab = <NotesPanel notes={notes} refresh={refresh} />;

  const projectsTab = (
    <ProjectsPanel projects={projects} events={events} refresh={refresh} />
  );

  return (
    <>
      {/* JARVIS power-on overlay — once per session, fades to reveal the app. */}
      <BootSequence />
      {/* Always mounted (not tied to the Calendar tab) so reminders fire no
          matter which tab is open. */}
      <Reminders events={openEvents} tasks={openTasks} />
      <MailApp
        assistant={assistant}
        tasks={tasksTab}
        calendar={calendarTab}
        notes={notesTab}
        projects={projectsTab}
      />
    </>
  );
}

const repeatLabel: Record<Recurrence, string> = {
  none: "",
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
};
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
const dkey = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sameDay = (a: Date, b: Date) => dkey(a) === dkey(b);
const timeStr = (d: Date) => d.toLocaleTimeString([], { timeStyle: "short" });

/* ───────────────────────── Tasks — to-do list ───────────────────────── */
function TasksPanel({ tasks, refresh }: { tasks: Task[]; refresh: () => void }) {
  const [title, setTitle] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [showDone, setShowDone] = useState(false);

  // Open tasks sorted high → medium → low so priority is reflected in the order;
  // ties keep the API's order (newest first). slice() so we don't mutate props.
  const PRIO_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const open = tasks
    .filter((t) => !t.done)
    .slice()
    .sort((a, b) => (PRIO_ORDER[a.priority] ?? 1) - (PRIO_ORDER[b.priority] ?? 1));
  const done = tasks.filter((t) => t.done);

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
  const saveTitle = async (id: string, value: string) => {
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: value }),
    });
    setEditingId(null);
    refresh();
  };
  // Click the priority dot to cycle low → medium → high → low.
  const cyclePriority = async (t: Task) => {
    const next =
      t.priority === "low" ? "medium" : t.priority === "medium" ? "high" : "low";
    await fetch(`/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: next }),
    });
    refresh();
  };

  // subtasks (Google-Tasks style) — kept in the panel, fetched on its own
  const [subs, setSubs] = useState<Subtask[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [subDraft, setSubDraft] = useState("");
  const loadSubs = useCallback(async () => {
    try {
      const r = await fetch("/api/subtasks", { cache: "no-store" });
      setSubs(await r.json());
    } catch {
      /* leave as-is */
    }
  }, []);
  useEffect(() => {
    loadSubs();
  }, [loadSubs]);

  const toIso = (v: string) => (v ? new Date(v).toISOString() : null);
  const toInput = (iso: string | null) => (iso ? toLocalInput(new Date(iso)) : "");

  const setDue = async (id: string, iso: string | null) => {
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dueDate: iso }),
    });
    refresh();
  };
  const delWithSubs = async (id: string) => {
    await del(id);
    loadSubs();
  };

  const subsFor = (taskId: string) => subs.filter((s) => s.taskId === taskId);
  const addSub = async (taskId: string) => {
    if (!subDraft.trim()) return;
    await fetch("/api/subtasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, title: subDraft.trim() }),
    });
    setSubDraft("");
    loadSubs();
  };
  const patchSub = async (id: string, body: object) => {
    await fetch(`/api/subtasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    loadSubs();
  };
  const delSub = async (id: string) => {
    await fetch(`/api/subtasks/${id}`, { method: "DELETE" });
    loadSubs();
  };

  const row = (t: Task) => {
    const tSubs = subsFor(t.id);
    const open = expanded === t.id;
    const doneSubs = tSubs.filter((s) => s.done).length;
    return (
      <li key={t.id} className={`todo-item${t.done ? " is-done" : ""}${open ? " open" : ""}`}>
        <div className="todo-row">
          <button
            className={`todo-check${t.done ? " on" : ""}`}
            onClick={() => toggle(t)}
            aria-label={t.done ? "Mark not done" : "Mark done"}
          >
            {t.done ? "✓" : ""}
          </button>
          <button
            type="button"
            className={`todo-prio p-${t.priority}`}
            title={`${t.priority} priority — click to change`}
            aria-label={`Priority: ${t.priority}. Click to change.`}
            onClick={() => cyclePriority(t)}
            style={{ border: "none", padding: 0, cursor: "pointer" }}
          />
          <div className="todo-main">
            {editingId === t.id ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => saveTitle(t.id, draft)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveTitle(t.id, draft);
                  if (e.key === "Escape") setEditingId(null);
                }}
                className="todo-edit"
              />
            ) : (
              <span
                className="todo-title"
                title="click to edit"
                onClick={() => {
                  setEditingId(t.id);
                  setDraft(t.title);
                }}
              >
                {t.title}
              </span>
            )}
            <div className="todo-meta">
              {t.dueDate && <span className="todo-due">🕑 {fmt(t.dueDate)}</span>}
              {tSubs.length > 0 && (
                <span className="todo-sub-count">
                  {doneSubs}/{tSubs.length} subtasks
                </span>
              )}
            </div>
          </div>
          <RefChip id={taskRef(t)} />
          <button
            className={`todo-expand${open ? " open" : ""}`}
            onClick={() => setExpanded(open ? null : t.id)}
            title="Edit date & subtasks"
            aria-label="Edit date & subtasks"
          >
            ⌄
          </button>
          <button className="icon-x" onClick={() => delWithSubs(t.id)} title="Delete">
            ✕
          </button>
        </div>

        {open && (
          <div className="todo-detail">
            <div className="todo-detail-row">
              <label className="todo-detail-lbl">Due</label>
              <DateField
                value={toInput(t.dueDate)}
                onChange={(v) => setDue(t.id, toIso(v))}
                placeholder="No date"
              />
              {t.dueDate && (
                <button className="ghost-btn" onClick={() => setDue(t.id, null)}>
                  Clear
                </button>
              )}
            </div>

            <ul className="subtask-list">
              {tSubs.map((s) => (
                <li key={s.id} className={`subtask${s.done ? " is-done" : ""}`}>
                  <button
                    className={`todo-check sm${s.done ? " on" : ""}`}
                    onClick={() => patchSub(s.id, { done: !s.done })}
                    aria-label={s.done ? "Mark not done" : "Mark done"}
                  >
                    {s.done ? "✓" : ""}
                  </button>
                  <input
                    className="subtask-title"
                    defaultValue={s.title}
                    onBlur={(e) => e.target.value !== s.title && patchSub(s.id, { title: e.target.value })}
                  />
                  <DateField
                    value={toInput(s.dueDate)}
                    onChange={(v) => patchSub(s.id, { dueDate: toIso(v) })}
                    placeholder="Date"
                    className="subtask-date"
                  />
                  <button className="icon-x" onClick={() => delSub(s.id)} title="Delete subtask">
                    ✕
                  </button>
                </li>
              ))}
            </ul>

            <div className="subtask-add">
              <input
                value={expanded === t.id ? subDraft : ""}
                onChange={(e) => setSubDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addSub(t.id)}
                placeholder="Add a subtask…"
              />
              <button className="todo-add-btn sm" onClick={() => addSub(t.id)} aria-label="Add subtask">
                +
              </button>
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="todo">
      <header className="tab-head">
        <h1>Tasks</h1>
        <p className="tab-sub">
          {open.length} open · {done.length} done
        </p>
      </header>

      <div className="todo-add">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Add a task and press Enter…"
        />
        <button className="todo-add-btn" onClick={add} aria-label="Add task">
          +
        </button>
      </div>

      <ul className="todo-list">
        {open.map(row)}
        {open.length === 0 && <li className="todo-empty">All clear. Nothing to do 🎉</li>}
      </ul>

      {done.length > 0 && (
        <div className="todo-done">
          <button className="todo-done-toggle" onClick={() => setShowDone((s) => !s)}>
            {showDone ? "▾" : "▸"} Completed ({done.length})
          </button>
          {showDone && <ul className="todo-list">{done.map(row)}</ul>}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Calendar — month grid ───────────────────────── */
type DayItem =
  | {
      kind: "event";
      id: string;
      seq: number;
      title: string;
      start: Date;
      end: Date;
      recurrence: Recurrence;
      done: boolean;
      project: boolean;
    }
  | { kind: "task"; id: string; seq: number; title: string; due: Date; done: boolean; priority: string }
  | { kind: "note"; id: string; seq: number; title: string; date: Date };

function CalendarPanel({
  events,
  tasks,
  notes,
  refresh,
}: {
  events: Event[];
  tasks: Task[];
  notes: Note[];
  refresh: () => void;
}) {
  const today = new Date();
  const [view, setView] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });

  // add-event form
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [recurrence, setRecurrence] = useState<Recurrence>("none");
  // inline edit
  const [editId, setEditId] = useState<string | null>(null);
  const [eTitle, setETitle] = useState("");
  const [eStart, setEStart] = useState("");
  const [eEnd, setEEnd] = useState("");

  const add = async () => {
    if (!title.trim() || !start || !end) return;
    await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        startTime: new Date(start).toISOString(),
        endTime: new Date(end).toISOString(),
        recurrence,
      }),
    });
    setTitle("");
    setRecurrence("none");
    refresh();
  };
  const patchEvent = async (id: string, body: object) => {
    await fetch(`/api/events/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    refresh();
  };
  const delEvent = async (id: string) => {
    await fetch(`/api/events/${id}`, { method: "DELETE" });
    refresh();
  };
  const patchTask = async (id: string, body: object) => {
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    refresh();
  };
  const delTask = async (id: string) => {
    await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    refresh();
  };

  const openEdit = (id: string, t: string, s: Date, e: Date) => {
    setEditId(id);
    setETitle(t);
    setEStart(toLocalInput(s));
    setEEnd(toLocalInput(e));
  };
  const saveEdit = async () => {
    if (!editId) return;
    await patchEvent(editId, {
      title: eTitle,
      startTime: new Date(eStart).toISOString(),
      endTime: new Date(eEnd).toISOString(),
    });
    setEditId(null);
  };

  const pickDay = (d: Date) => {
    setSelected(d);
    const s = new Date(d);
    s.setHours(9, 0, 0, 0);
    const e = new Date(d);
    e.setHours(10, 0, 0, 0);
    setStart(toLocalInput(s));
    setEnd(toLocalInput(e));
  };

  // 6-week grid starting on the Sunday on/before the 1st of the view month
  const monthStart = new Date(view.getFullYear(), view.getMonth(), 1);
  const gridStart = new Date(monthStart);
  gridStart.setDate(1 - monthStart.getDay());
  const cells: Date[] = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const rangeEnd = new Date(cells[41]);
  rangeEnd.setHours(23, 59, 59, 999);

  const eventDone = new Map(events.map((e) => [e.id, e.done]));
  const eventProject = new Map(events.map((e) => [e.id, !!e.projectId]));
  const byDay = new Map<string, DayItem[]>();
  const push = (d: Date, it: DayItem) => {
    const k = dkey(d);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(it);
  };
  for (const occ of expandEvents(events, gridStart, rangeEnd)) {
    const s = new Date(occ.startTime);
    push(s, {
      kind: "event",
      id: occ.id,
      seq: (occ as unknown as { seq: number }).seq,
      title: occ.title,
      start: s,
      end: new Date(occ.endTime),
      recurrence: (occ.recurrence ?? "none") as Recurrence,
      done: !!eventDone.get(occ.id),
      project: !!eventProject.get(occ.id),
    });
  }
  for (const t of tasks) {
    if (!t.dueDate) continue;
    const due = new Date(t.dueDate);
    if (due >= gridStart && due <= rangeEnd)
      push(due, {
        kind: "task",
        id: t.id,
        seq: t.seq,
        title: t.title,
        due,
        done: t.done,
        priority: t.priority,
      });
  }
  for (const n of notes) {
    if (!n.date) continue;
    const d = new Date(n.date);
    if (d >= gridStart && d <= rangeEnd)
      push(d, {
        kind: "note",
        id: n.id,
        seq: n.seq,
        title: n.title || n.body.slice(0, 40) || "Note",
        date: d,
      });
  }
  const itemTime = (it: DayItem) =>
    it.kind === "event" ? it.start.getTime() : it.kind === "task" ? it.due.getTime() : it.date.getTime();
  for (const list of byDay.values()) list.sort((a, b) => itemTime(a) - itemTime(b));

  const dayItems = (byDay.get(dkey(selected)) ?? []).slice();

  return (
    <div className="cal">
      <header className="cal-head">
        <div>
          <h1>
            {MONTHS[view.getMonth()]} <span className="cal-year">{view.getFullYear()}</span>
          </h1>
        </div>
        <div className="cal-nav">
          <button onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}>
            ‹
          </button>
          <button
            className="cal-today"
            onClick={() => {
              const n = new Date();
              setView(new Date(n.getFullYear(), n.getMonth(), 1));
              pickDay(new Date(n.getFullYear(), n.getMonth(), n.getDate()));
            }}
          >
            Today
          </button>
          <button onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}>
            ›
          </button>
        </div>
      </header>

      <div className="cal-grid">
        {WEEKDAYS.map((d) => (
          <div key={d} className="cal-dow">
            {d}
          </div>
        ))}
        {cells.map((day) => {
          const items = byDay.get(dkey(day)) ?? [];
          const muted = day.getMonth() !== view.getMonth();
          const isToday = sameDay(day, today);
          const isSel = sameDay(day, selected);
          return (
            <button
              key={dkey(day)}
              className={`cal-cell${muted ? " muted" : ""}${isToday ? " today" : ""}${
                isSel ? " selected" : ""
              }`}
              onClick={() => pickDay(day)}
            >
              <span className="cal-daynum">{day.getDate()}</span>
              <div className="cal-chips">
                {items.slice(0, 3).map((it, i) => {
                  const isProject = it.kind === "event" && it.project;
                  const done = (it.kind === "event" || it.kind === "task") && it.done;
                  const icon = isProject ? "🗂 " : it.kind === "note" ? "📝 " : "";
                  return (
                    <span
                      key={i}
                      className={`cal-chip ${isProject ? "project" : it.kind}${done ? " done" : ""}`}
                      title={it.title}
                    >
                      {icon}
                      {it.title}
                    </span>
                  );
                })}
                {items.length > 3 && <span className="cal-more">+{items.length - 3} more</span>}
              </div>
            </button>
          );
        })}
      </div>

      {/* Selected-day detail + add */}
      <div className="cal-detail">
        <h2>
          {selected.toLocaleDateString([], {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </h2>

        <ul className="cal-day-list">
          {dayItems.map((it) =>
            it.kind === "event" && editId === it.id ? (
              <li key={it.id} className="cal-day-edit">
                <input value={eTitle} onChange={(e) => setETitle(e.target.value)} />
                <DateField value={eStart} onChange={setEStart} />
                <DateField value={eEnd} onChange={setEEnd} />
                <div className="cal-day-actions">
                  <button className="a-btn" onClick={saveEdit}>
                    Save
                  </button>
                  <button className="ghost-btn" onClick={() => setEditId(null)}>
                    Cancel
                  </button>
                </div>
              </li>
            ) : it.kind === "note" ? (
              <li key={`note-${it.id}`} className="cal-day-item">
                <span className="cal-dot note" />
                <div className="cal-day-main">
                  <div className="cal-day-title">
                    <RefChip id={refOf("note", it.seq)} />
                    <span className="cal-kind-icon" title="Note">📝</span>
                    <span>{it.title}</span>
                  </div>
                  <div className="cal-day-time">note</div>
                </div>
              </li>
            ) : (
              <li key={`${it.kind}-${it.id}`} className={`cal-day-item${it.done ? " is-done" : ""}`}>
                <span
                  className={`cal-dot ${
                    it.kind === "event" && it.project ? "project" : it.kind
                  }`}
                />
                <div className="cal-day-main">
                  <div className="cal-day-title">
                    <RefChip id={refOf(it.kind, it.seq)} />
                    {it.kind === "event" && it.project && (
                      <span className="cal-kind-icon" title="Project event">🗂</span>
                    )}
                    <span>{it.title}</span>
                    {it.kind === "event" && it.recurrence !== "none" && (
                      <span className="cal-repeat">↻ {repeatLabel[it.recurrence]}</span>
                    )}
                  </div>
                  <div className="cal-day-time">
                    {it.kind === "event"
                      ? `${timeStr(it.start)} → ${timeStr(it.end)}`
                      : `due ${timeStr(it.due)}`}
                  </div>
                </div>
                <button
                  className="icon-ok"
                  title="Mark done"
                  onClick={() =>
                    it.kind === "event"
                      ? patchEvent(it.id, { done: true })
                      : patchTask(it.id, { done: true })
                  }
                >
                  ✓
                </button>
                {it.kind === "event" && (
                  <button
                    className="icon-edit"
                    title="Edit"
                    onClick={() => openEdit(it.id, it.title, it.start, it.end)}
                  >
                    ✎
                  </button>
                )}
                <button
                  className="icon-x"
                  title="Delete"
                  onClick={() => (it.kind === "event" ? delEvent(it.id) : delTask(it.id))}
                >
                  ✕
                </button>
              </li>
            )
          )}
          {dayItems.length === 0 && <li className="cal-day-empty">Nothing scheduled.</li>}
        </ul>

        <div className="cal-add">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New event title…"
          />
          <div className="cal-add-row">
            <DateField value={start} onChange={setStart} placeholder="Starts" />
            <DateField value={end} onChange={setEnd} placeholder="Ends" />
          </div>
          <div className="cal-add-row">
            <Select
              value={recurrence}
              onChange={(v) => setRecurrence(v as Recurrence)}
              options={[
                { value: "none", label: "Does not repeat" },
                { value: "daily", label: "Every day" },
                { value: "weekly", label: "Every week" },
                { value: "monthly", label: "Every month" },
              ]}
            />
            <button className="a-btn" onClick={add}>
              Add event
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Notes — Google-Keep cards ───────────────────────── */
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
  const setDate = async (id: string, iso: string | null) => {
    await fetch(`/api/notes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: iso }),
    });
    refresh();
  };
  const del = async (id: string) => {
    await fetch(`/api/notes/${id}`, { method: "DELETE" });
    refresh();
  };

  return (
    <div className="keep">
      <header className="tab-head">
        <h1>Notes</h1>
        <p className="tab-sub">{notes.length} notes</p>
      </header>

      <div className="keep-add">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Take a note…"
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add();
          }}
        />
        <button className="a-btn" onClick={add}>
          Add
        </button>
      </div>

      <div className="keep-grid">
        {notes.map((n) => (
          <div key={n.id} className="keep-card">
            {n.date && (
              <div className="keep-card-date">
                📅 {new Date(n.date).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
              </div>
            )}
            <textarea
              className="keep-card-body"
              defaultValue={n.body}
              onBlur={(e) => e.target.value !== n.body && save(n.id, e.target.value)}
            />
            <div className="keep-card-foot">
              <DateField
                value={n.date ? new Date(n.date).toISOString().slice(0, 10) : ""}
                onChange={(v) => setDate(n.id, v ? new Date(v).toISOString() : null)}
                withTime={false}
                placeholder="Add date"
                className="keep-date"
              />
              <RefChip id={noteRef(n)} />
              <button className="icon-x" onClick={() => del(n.id)} title="Delete">
                🗑
              </button>
            </div>
          </div>
        ))}
        {notes.length === 0 && <p className="keep-empty">No notes yet. Jot one above.</p>}
      </div>
    </div>
  );
}

/* ───────────────────────── Projects — improvement cards ───────────────────────── */
function ProjectsPanel({
  projects,
  events,
  refresh,
}: {
  projects: Project[];
  events: Event[];
  refresh: () => void;
}) {
  const [title, setTitle] = useState("");
  const [showDone, setShowDone] = useState(false);

  const openProjects = projects.filter((p) => !p.done);
  const doneProjects = projects.filter((p) => p.done);

  const addProject = async () => {
    if (!title.trim()) return;
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    setTitle("");
    refresh();
  };
  const patch = async (id: string, body: object) => {
    await fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    refresh();
  };
  const del = async (id: string) => {
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    refresh();
  };

  return (
    <div className="proj">
      <header className="tab-head">
        <h1>Projects</h1>
        <p className="tab-sub">
          {openProjects.length} active · {doneProjects.length} done
        </p>
      </header>

      <div className="proj-add">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addProject()}
          placeholder="New project name…"
        />
        <button className="a-btn" onClick={addProject}>
          Add project
        </button>
      </div>

      <div className="proj-grid">
        {openProjects.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            times={events
              .filter((e) => e.projectId === p.id)
              .sort((a, b) => a.startTime.localeCompare(b.startTime))}
            onPatch={(body) => patch(p.id, body)}
            onDelete={() => del(p.id)}
            refresh={refresh}
          />
        ))}
        {openProjects.length === 0 && (
          <p className="keep-empty">No active projects. Create one above.</p>
        )}
      </div>

      {doneProjects.length > 0 && (
        <div className="proj-done">
          <button className="todo-done-toggle" onClick={() => setShowDone((s) => !s)}>
            {showDone ? "▾" : "▸"} Completed ({doneProjects.length})
          </button>
          {showDone && (
            <div className="proj-grid">
              {doneProjects.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  times={events
                    .filter((e) => e.projectId === p.id)
                    .sort((a, b) => a.startTime.localeCompare(b.startTime))}
                  onPatch={(body) => patch(p.id, body)}
                  onDelete={() => del(p.id)}
                  refresh={refresh}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  times,
  onPatch,
  onDelete,
  refresh,
}: {
  project: Project;
  times: Event[];
  onPatch: (body: object) => void;
  onDelete: () => void;
  refresh: () => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(project.title);
  const [newImp, setNewImp] = useState("");
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [impDraft, setImpDraft] = useState("");
  const [showTime, setShowTime] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  // Inline edit of an existing scheduled time (event id → draft start/end).
  const [editTimeId, setEditTimeId] = useState<string | null>(null);
  const [tStart, setTStart] = useState("");
  const [tEnd, setTEnd] = useState("");

  const improvements = project.improvements ?? [];
  const impTimes = project.improvementTimes ?? {};
  const impToInput = (imp: string) => (impTimes[imp] ? toLocalInput(new Date(impTimes[imp])) : "");

  const saveTitle = () => {
    setEditingTitle(false);
    if (titleDraft.trim() && titleDraft !== project.title)
      onPatch({ title: titleDraft.trim() });
  };
  const addImp = () => {
    if (!newImp.trim()) return;
    onPatch({ improvements: [...improvements, newImp.trim()] });
    setNewImp("");
  };
  const saveImp = (idx: number) => {
    setEditIdx(null);
    const next = improvements.slice();
    if (!impDraft.trim()) return;
    const oldText = next[idx];
    const newText = impDraft.trim();
    next[idx] = newText;
    const body: { improvements: string[]; improvementTimes?: Record<string, string> } = {
      improvements: next,
    };
    // Keep the scheduled time attached when the text is renamed.
    if (oldText !== newText && impTimes[oldText]) {
      const t = { ...impTimes };
      t[newText] = t[oldText];
      delete t[oldText];
      body.improvementTimes = t;
    }
    onPatch(body);
  };
  const delImp = (idx: number) => {
    const removed = improvements[idx];
    const t = { ...impTimes };
    delete t[removed];
    onPatch({ improvements: improvements.filter((_, i) => i !== idx), improvementTimes: t });
  };
  const setImpTime = (imp: string, iso: string | null) => {
    const t = { ...impTimes };
    if (iso) t[imp] = iso;
    else delete t[imp];
    onPatch({ improvementTimes: t });
  };
  const addTime = () => {
    if (!start) return;
    // End is optional — default to one hour after the start.
    const startD = new Date(start);
    const endD = end ? new Date(end) : new Date(startD.getTime() + 3600000);
    fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: project.title,
        startTime: startD.toISOString(),
        endTime: endD.toISOString(),
        projectId: project.id,
      }),
    }).then(() => {
      setShowTime(false);
      setStart("");
      setEnd("");
      refresh();
    });
  };
  const openTimeEdit = (ev: Event) => {
    setEditTimeId(ev.id);
    setTStart(toLocalInput(new Date(ev.startTime)));
    setTEnd(toLocalInput(new Date(ev.endTime)));
  };
  const saveTimeEdit = async () => {
    if (!editTimeId || !tStart) return;
    const startD = new Date(tStart);
    const endD = tEnd ? new Date(tEnd) : new Date(startD.getTime() + 3600000);
    await fetch(`/api/events/${editTimeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startTime: startD.toISOString(),
        endTime: endD.toISOString(),
      }),
    });
    setEditTimeId(null);
    refresh();
  };
  const delTime = async (id: string) => {
    await fetch(`/api/events/${id}`, { method: "DELETE" });
    refresh();
  };

  return (
    <div className={`proj-card${project.done ? " is-done" : ""}`}>
      <div className="proj-card-head">
        <button
          className={`todo-check${project.done ? " on" : ""}`}
          title={project.done ? "Reopen project" : "Mark project complete"}
          onClick={() => onPatch({ done: !project.done })}
        >
          {project.done ? "✓" : ""}
        </button>
        {editingTitle ? (
          <input
            autoFocus
            className="proj-title-edit"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveTitle();
              if (e.key === "Escape") setEditingTitle(false);
            }}
          />
        ) : (
          <h3
            className="proj-title"
            title="click to rename"
            onClick={() => {
              setTitleDraft(project.title);
              setEditingTitle(true);
            }}
          >
            🗂 {project.title}
          </h3>
        )}
        <RefChip id={projectRef(project)} />
        <button className="icon-x" onClick={onDelete} title="Delete project">
          🗑
        </button>
      </div>

      <ul className="proj-imps">
        {improvements.map((imp, idx) => (
          <li key={idx} className="proj-imp">
            <div className="proj-imp-main">
              {editIdx === idx ? (
                <input
                  autoFocus
                  className="proj-imp-edit"
                  value={impDraft}
                  onChange={(e) => setImpDraft(e.target.value)}
                  onBlur={() => saveImp(idx)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveImp(idx);
                    if (e.key === "Escape") setEditIdx(null);
                  }}
                />
              ) : (
                <span
                  className="proj-imp-text"
                  title="click to edit"
                  onClick={() => {
                    setEditIdx(idx);
                    setImpDraft(imp);
                  }}
                >
                  {imp}
                </span>
              )}
              <button className="icon-x" onClick={() => delImp(idx)} title="Delete">
                ✕
              </button>
            </div>
            <DateField
              value={impToInput(imp)}
              onChange={(v) => setImpTime(imp, v ? new Date(v).toISOString() : null)}
              placeholder="Add time"
              className="proj-imp-date"
            />
          </li>
        ))}
        {improvements.length === 0 && (
          <li className="proj-imp-empty">No improvements yet.</li>
        )}
      </ul>

      <div className="proj-imp-add">
        <input
          value={newImp}
          onChange={(e) => setNewImp(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addImp()}
          placeholder="Write an improvement…"
        />
        <button className="proj-add-btn" onClick={addImp} aria-label="Add improvement">
          +
        </button>
      </div>

      {times.length > 0 && (
        <ul className="proj-times">
          {times.map((ev) =>
            editTimeId === ev.id ? (
              <li key={ev.id} className="proj-time-edit">
                <DateField value={tStart} onChange={setTStart} placeholder="Start" />
                <DateField value={tEnd} onChange={setTEnd} placeholder="End" />
                <button className="a-btn" onClick={saveTimeEdit}>
                  Save
                </button>
                <button className="ghost-btn" onClick={() => setEditTimeId(null)}>
                  Cancel
                </button>
              </li>
            ) : (
              <li key={ev.id} className={`proj-time-row${ev.done ? " is-done" : ""}`}>
                <span className="proj-time-when">
                  🗓 {fmt(ev.startTime)} → {timeStr(new Date(ev.endTime))}
                </span>
                <button className="icon-edit" title="Edit time" onClick={() => openTimeEdit(ev)}>
                  ✎
                </button>
                <button className="icon-x" title="Delete time" onClick={() => delTime(ev.id)}>
                  ✕
                </button>
              </li>
            )
          )}
        </ul>
      )}

      <div className="proj-card-foot">
        <button className="ghost-btn" onClick={() => setShowTime((s) => !s)}>
          {showTime ? "▾ Add time" : "＋ Add time"}
        </button>
      </div>
      {showTime && (
        <div className="proj-time">
          <label className="proj-time-lbl">
            Start
            <DateField value={start} onChange={setStart} placeholder="Start" />
          </label>
          <label className="proj-time-lbl">
            End (optional)
            <DateField value={end} onChange={setEnd} placeholder="End" />
          </label>
          <button className="a-btn" onClick={addTime}>
            Schedule
          </button>
        </div>
      )}
    </div>
  );
}
