"use client";

// Reusable black-&-white form controls — a custom dropdown and a popup calendar
// date/time picker — so the app never falls back to ugly native selects/pickers.

import { useEffect, useRef, useState } from "react";

/* ───────────────────────── custom select ───────────────────────── */
export type Opt = { value: string; label: string };

export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: Opt[];
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", h);
    return () => window.removeEventListener("pointerdown", h);
  }, [open]);

  const cur = options.find((o) => o.value === value);
  return (
    <div className={`ui-select${open ? " open" : ""} ${className}`} ref={ref}>
      <button type="button" className="ui-select-trigger" onClick={() => setOpen((o) => !o)}>
        <span className={cur ? "" : "ui-ph"}>{cur ? cur.label : placeholder}</span>
        <span className="ui-caret" aria-hidden />
      </button>
      {open && (
        <div className="ui-menu" role="listbox">
          {options.map((o) => (
            <button
              type="button"
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`ui-opt${o.value === value ? " sel" : ""}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── custom date/time picker ───────────────────────── */
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const pad = (n: number) => String(n).padStart(2, "0");

function parse(value: string): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
}
function toValue(d: Date, withTime: boolean) {
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${base}T${pad(d.getHours())}:${pad(d.getMinutes())}` : base;
}
function label(d: Date | null, withTime: boolean, placeholder: string) {
  if (!d) return placeholder;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  if (!withTime) return date;
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
}

export function DateField({
  value,
  onChange,
  withTime = true,
  placeholder = "Pick a date",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  withTime?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sel = parse(value);
  const [view, setView] = useState(() => {
    const d = sel ?? new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", h);
    return () => window.removeEventListener("pointerdown", h);
  }, [open]);

  // 6-week grid from the Sunday on/before the 1st.
  const monthStart = new Date(view.getFullYear(), view.getMonth(), 1);
  const gridStart = new Date(monthStart);
  gridStart.setDate(1 - monthStart.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
  const today = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  const commit = (next: Date) => onChange(toValue(next, withTime));
  const pickDay = (d: Date) => {
    const base = sel ?? (() => { const n = new Date(); n.setHours(9, 0, 0, 0); return n; })();
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), base.getHours(), base.getMinutes());
    commit(next);
    if (!withTime) setOpen(false);
  };
  const setTime = (h: number, m: number) => {
    const base = sel ?? new Date(view.getFullYear(), view.getMonth(), today.getDate());
    commit(new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m));
  };

  return (
    <div className={`ui-date${open ? " open" : ""} ${className}`} ref={ref}>
      <button type="button" className="ui-date-trigger" onClick={() => setOpen((o) => !o)}>
        <span className={sel ? "" : "ui-ph"}>{label(sel, withTime, placeholder)}</span>
        <span className="ui-cal-ico" aria-hidden />
      </button>
      {open && (
        <div className="ui-cal">
          <div className="ui-cal-head">
            <button type="button" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}>‹</button>
            <span>{MONTHS[view.getMonth()]} {view.getFullYear()}</span>
            <button type="button" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}>›</button>
          </div>
          <div className="ui-cal-dow">{DOW.map((d, i) => <span key={i}>{d}</span>)}</div>
          <div className="ui-cal-grid">
            {cells.map((d, i) => (
              <button
                type="button"
                key={i}
                className={`ui-cal-day${d.getMonth() !== view.getMonth() ? " muted" : ""}${
                  sameDay(d, today) ? " today" : ""}${sel && sameDay(d, sel) ? " sel" : ""}`}
                onClick={() => pickDay(d)}
              >
                {d.getDate()}
              </button>
            ))}
          </div>
          {withTime && (
            <div className="ui-cal-time">
              <input
                type="number" min={0} max={23}
                value={sel ? pad(sel.getHours()) : "09"}
                onChange={(e) => setTime(Math.min(23, Math.max(0, +e.target.value || 0)), sel?.getMinutes() ?? 0)}
              />
              <span>:</span>
              <input
                type="number" min={0} max={59}
                value={sel ? pad(sel.getMinutes()) : "00"}
                onChange={(e) => setTime(sel?.getHours() ?? 9, Math.min(59, Math.max(0, +e.target.value || 0)))}
              />
              <button type="button" className="ui-cal-done" onClick={() => setOpen(false)}>Done</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
