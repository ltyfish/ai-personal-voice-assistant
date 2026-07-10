"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Summary } from "@/lib/mail/types";
import Abilities from "@/components/Abilities";
import Local from "@/components/Local";
import LLMKeys from "@/components/LLMKeys";
import GitHub from "@/components/GitHub";
import ModelHud from "@/components/ModelHud";
import MiniOrb from "@/components/jarvis/MiniOrb";
import StatusIndicator from "@/components/jarvis/StatusIndicator";
import ToastHost from "@/components/Toast";
import { notify, confirmDialog } from "@/lib/toast";
import { useLocalPresence } from "@/lib/local-presence";

type View = "feed" | "digest" | "urgency" | "settings";
type Tab = "assistant" | "tasks" | "calendar" | "notes" | "projects" | "abilities" | "local" | "freellmapi" | "github" | View;

const URGENCY_LABELS = ["", "Minimal", "Low", "Medium", "High", "Critical"];
const MORE_TAB_IDS = new Set<Tab>([
  "tasks", "notes", "projects", "github", "feed", "digest", "urgency",
]);

const TAB_GLYPHS: Record<Tab, string> = {
  assistant: "AI",
  tasks: "TK",
  calendar: "CL",
  notes: "NT",
  projects: "PJ",
  abilities: "AB",
  local: "LC",
  freellmapi: "MD",
  github: "GH",
  feed: "IN",
  digest: "DG",
  urgency: "UR",
  settings: "ST",
};

// ───────────────────────── api hook ─────────────────────────
function useApi(secret: string) {
  return useCallback(
    async (path: string, opts: RequestInit = {}) => {
      const res = await fetch(`/api/mail/${path}`, {
        ...opts,
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
          ...(opts.headers ?? {}),
        },
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      return res.json();
    },
    [secret]
  );
}

type Api = ReturnType<typeof useApi>;

// ───────────────────────── root ─────────────────────────
// `assistant` is the Personal AI dashboard, shown in its own first tab so the
// whole app lives on one themed page (no separate /mail route needed).
export default function MailApp({
  assistant,
  tasks,
  calendar,
  notes,
  projects,
}: {
  assistant?: ReactNode;
  tasks?: ReactNode;
  calendar?: ReactNode;
  notes?: ReactNode;
  projects?: ReactNode;
}) {
  const [secret, setSecret] = useState<string>("");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [tab, setTab] = useState<Tab>(assistant ? "assistant" : "feed");
  const [ready, setReady] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  // On phones the inline tab pill can't fit; below this width we hide it and the
  // hamburger holds the FULL tab list instead (a standard mobile nav).
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const apply = () => setIsNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Local-computer presence — drives whether the "Local" tab is shown at all.
  // Offline (computer off / bridge down) → tab hidden, Jarvis stays cloud-only.
  const { status: localStatus } = useLocalPresence();
  const localOnline = localStatus.bridge;

  useEffect(() => {
    // Load the saved secret WITHOUT prompting — we only prompt when the user
    // actually opens a mail tab that needs it.
    setSecret(localStorage.getItem("dashboardSecret") ?? "");
    setTheme((localStorage.getItem("theme") as "dark" | "light") ?? "dark");
    setReady(true);
  }, []);

  // Let the voice assistant steer the active tab (e.g. "add a task" → Tasks).
  // Skip mail tabs we don't have the secret for, so we never strand the user.
  useEffect(() => {
    const onNav = (e: Event) => {
      const t = (e as CustomEvent).detail as Tab;
      if (!t) return;
      const openOnly = ["assistant", "tasks", "calendar", "notes", "projects", "abilities", "local"];
      if (!openOnly.includes(t) && !secret) return;
      setTab(t);
    };
    window.addEventListener("jarvis-nav", onNav);
    return () => window.removeEventListener("jarvis-nav", onNav);
  }, [secret]);

  // Tabs that don't need the email DASHBOARD_SECRET (purely local/static).
  const isOpenTab = (t: Tab) =>
    t === "assistant" ||
    t === "tasks" ||
    t === "calendar" ||
    t === "notes" ||
    t === "projects" ||
    t === "abilities" ||
    t === "local" ||
    t === "freellmapi" ||
    t === "github";

  // If the computer goes offline while the Local tab is open, fall back to
  // JARVIS so the user never lingers on a dead tab.
  useEffect(() => {
    if (tab === "local" && !localOnline) setTab("assistant");
  }, [tab, localOnline]);

  // The hamburger menu stays open until the user clicks it again — it does NOT
  // close on outside click, Escape, or item selection (by request).

  // Switch tabs; mail tabs need the DASHBOARD_SECRET, so prompt on first use.
  const selectTab = (t: Tab) => {
    if (!isOpenTab(t) && !secret) {
      const entered = window.prompt("Enter your DASHBOARD_SECRET to view email:");
      if (!entered) return; // cancelled — stay where we are
      localStorage.setItem("dashboardSecret", entered);
      setSecret(entered);
    }
    setTab(t);
  };

  const api = useApi(secret);
  const isMail = !isOpenTab(tab);

  const TABS: { id: Tab; label: string }[] = [
    { id: "assistant", label: "JARVIS" },
    { id: "freellmapi", label: "Models" },
    ...(localOnline ? [{ id: "local" as Tab, label: "Local" }] : []),
    ...(calendar ? [{ id: "calendar" as Tab, label: "Calendar" }] : []),
    { id: "abilities", label: "Abilities" },
    { id: "settings", label: "Settings" },
    ...(tasks ? [{ id: "tasks" as Tab, label: "Tasks" }] : []),
    ...(notes ? [{ id: "notes" as Tab, label: "Notes" }] : []),
    ...(projects ? [{ id: "projects" as Tab, label: "Projects" }] : []),
    { id: "github", label: "GitHub" },
    { id: "feed", label: "Inbox" },
    { id: "digest", label: "Digest" },
    { id: "urgency", label: "Urgency" },
  ];
  const primaryTabs = TABS.filter((t) => t.id !== "assistant" && !MORE_TAB_IDS.has(t.id));
  const moreTabs = TABS.filter((t) => MORE_TAB_IDS.has(t.id));
  // On phones the inline pill is hidden, so the hamburger must list EVERY tab.
  const menuTabs = isNarrow ? TABS : moreTabs;
  const moreActive = menuTabs.some((t) => t.id === tab);

  if (!ready) return <div className="mailmind" data-theme={theme} />;

  return (
    <div className="mailmind" data-theme={theme} data-tab={tab}>
      <nav className="navbar">
        <button
          type="button"
          className={`nav-brand${tab === "assistant" ? " active" : ""}`}
          onClick={() => selectTab("assistant")}
          title="Go to JARVIS"
        >
          <span className="nav-brand-mark" aria-hidden="true">
            <span>J</span>
          </span>
          <span className="nav-brand-copy">
            <strong>JARVIS</strong>
            <small>Command workspace</small>
          </span>
        </button>
        <span className="nav-section-label">Workspace</span>
        <div className="nav-links">
          {primaryTabs.map((t) => (
            <a
              key={t.id}
              href={`#${t.id}`}
              className={`nav-link${tab === t.id ? " active" : ""}`}
              onClick={(e) => {
                e.preventDefault();
                selectTab(t.id);
              }}
            >
              <span className="nav-link-glyph" aria-hidden="true">{TAB_GLYPHS[t.id]}</span>
              {t.label}
            </a>
          ))}
        </div>
      </nav>

      {/* Hamburger lives in its own nav, pinned to the far right of the screen.
          On desktop it holds the overflow ("more") tabs; on mobile the inline
          pill is hidden and this holds EVERY tab. */}
      {menuTabs.length > 0 && (
        <div className="nav-more" ref={moreRef}>
          <button
            className={`nav-burger${moreOpen ? " open" : ""}${moreActive ? " active" : ""}`}
            type="button"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-label="More tabs"
            onClick={() => setMoreOpen((v) => !v)}
          >
            <span className="nav-burger-lines" aria-hidden="true">
              <span /><span /><span />
            </span>
          </button>
          {moreOpen && (
            <div className="nav-more-menu" role="menu">
              {menuTabs.map((t) => (
                <a
                  key={t.id}
                  href={`#${t.id}`}
                  className={`nav-more-item${tab === t.id ? " active" : ""}`}
                  role="menuitem"
                  onClick={(e) => {
                    e.preventDefault();
                    selectTab(t.id);
                    // On mobile the menu IS the nav, so collapse it after picking.
                    if (isNarrow) setMoreOpen(false);
                  }}
                >
                  <span className="nav-link-glyph" aria-hidden="true">{TAB_GLYPHS[t.id]}</span>
                  {t.label}
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="layout">
        {isMail && <UrgentPanel api={api} />}
        <main className="main-content">
          {assistant && (
            <div className={`view${tab === "assistant" ? " active" : ""}`}>
              {assistant}
            </div>
          )}
          {tasks && (
            <div className={`view${tab === "tasks" ? " active" : ""}`}>
              <div className="modern-tab">{tasks}</div>
            </div>
          )}
          {calendar && (
            <div className={`view${tab === "calendar" ? " active" : ""}`}>
              <div className="modern-tab">{calendar}</div>
            </div>
          )}
          {notes && (
            <div className={`view${tab === "notes" ? " active" : ""}`}>
              <div className="modern-tab">{notes}</div>
            </div>
          )}
          {projects && (
            <div className={`view${tab === "projects" ? " active" : ""}`}>
              <div className="modern-tab">{projects}</div>
            </div>
          )}
          <div className={`view${tab === "abilities" ? " active" : ""}`}>
            <Abilities />
          </div>
          <div className={`view${tab === "freellmapi" ? " active" : ""}`}>
            <div className="modern-tab">
              <LLMKeys />
            </div>
          </div>
          <div className={`view${tab === "github" ? " active" : ""}`}>
            <div className="modern-tab">
              <GitHub />
            </div>
          </div>
          {localOnline && (
            <div className={`view${tab === "local" ? " active" : ""}`}>
              <div className="modern-tab">
                <Local status={localStatus} />
              </div>
            </div>
          )}
          <div className={`view${tab === "feed" ? " active" : ""}`}>
            <FeedView api={api} active={tab === "feed"} />
          </div>
          <div className={`view${tab === "digest" ? " active" : ""}`}>
            <DigestView api={api} active={tab === "digest"} />
          </div>
          <div className={`view${tab === "urgency" ? " active" : ""}`}>
            <UrgencyView />
          </div>
          <div className={`view${tab === "settings" ? " active" : ""}`}>
            <SettingsView api={api} active={tab === "settings"} secret={secret} />
          </div>
        </main>
      </div>

      {/* Persistent "systems online" status — stays on every tab. */}
      <StatusIndicator />

      {/* Persistent voice orb on the left — mirrors JARVIS state on every other
          tab so it lights up if you speak from anywhere. Hidden on the JARVIS tab. */}
      <MiniOrb />

      {/* App-wide toasts + confirm modal (replaces native alert/confirm). */}
      <ToastHost />

      {/* Floating, draggable current-model HUD — mounted once at the root so it
          survives tab switches (fixed-position, hide/unhide, persists). */}
      <ModelHud />
    </div>
  );
}

// ───────────────────────── urgency factors (localStorage) ─────────────────────────
type FactorState = Record<string, boolean>;
function loadFactors(): FactorState {
  try {
    return JSON.parse(localStorage.getItem("urgencyFactors") ?? "{}");
  } catch {
    return {};
  }
}

type DisplaySummary = Summary & { displayUrgency: number };
function applyBoosts(summaries: Summary[]): DisplaySummary[] {
  const factors = loadFactors();
  const today = new Date().toISOString().slice(0, 10);
  return summaries
    .map((s) => {
      let u = s.urgency;
      if (factors.recencyBoost && s.receivedAt?.slice(0, 10) === today)
        u = Math.min(5, u + 1);
      if (factors.deadlineBoost && s.deadlineMentioned) u = Math.min(5, u + 1);
      if (factors.replyBoost && s.requiresReply) u = Math.min(5, u + 1);
      return { ...s, displayUrgency: u };
    })
    .sort(
      (a, b) =>
        b.displayUrgency - a.displayUrgency ||
        b.receivedAt.localeCompare(a.receivedAt)
    );
}

// ───────────────────────── Feed view ─────────────────────────
function FeedView({ api, active }: { api: Api; active: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [categories, setCategories] = useState<string[]>([]);
  const [activeCat, setActiveCat] = useState("");
  const [account, setAccount] = useState("");
  const [urgency, setUrgency] = useState("");
  const [reviewed, setReviewed] = useState("");
  const [date, setDate] = useState(today);
  const [emails, setEmails] = useState<DisplaySummary[]>([]);
  const [fetching, setFetching] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (account) params.set("account", account);
    if (activeCat) params.set("category", activeCat);
    if (urgency) params.set("urgency", urgency);
    if (reviewed !== "") params.set("reviewed", reviewed);
    if (date) params.set("date", date);
    const summaries: Summary[] = await api(`get-summaries?${params}`).catch(() => []);
    setEmails(applyBoosts(summaries));
  }, [api, account, activeCat, urgency, reviewed, date]);

  useEffect(() => {
    api("get-settings")
      .then((c) => setCategories(c?.categories ?? []))
      .catch(() => {});
  }, [api]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const manualFetch = async () => {
    setFetching(true);
    try {
      const res = await api("manual-fetch?hoursBack=48", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (res.fetchError) notify(`Fetch error: ${res.fetchError}`, "error");
      else if (res.results?.[0]?.error) notify(`Gmail error: ${res.results[0].error}`, "error");
      setDate(new Date().toISOString().slice(0, 10));
      await load();
    } finally {
      setFetching(false);
    }
  };

  const markReviewed = async (s: DisplaySummary, next: boolean) => {
    await api("mark-reviewed", {
      method: "POST",
      body: JSON.stringify({
        emailId: s.emailId,
        date: s.receivedAt.slice(0, 10),
        reviewed: next,
      }),
    });
    setEmails((prev) =>
      prev.map((e) => (e.emailId === s.emailId ? { ...e, reviewed: next } : e))
    );
  };

  const urgent = emails.filter((s) => (s.displayUrgency ?? s.urgency) >= 4).length;
  const unread = emails.filter((s) => !s.reviewed).length;

  // group by date desc
  const byDate: Record<string, DisplaySummary[]> = {};
  for (const s of emails) {
    const d = s.receivedAt.slice(0, 10);
    (byDate[d] ??= []).push(s);
  }
  const groups = Object.entries(byDate).sort(([a], [b]) => b.localeCompare(a));

  return (
    <>
      {emails.length > 0 && (
        <div className="stats-bar">
          <div className="stat-chip">
            <strong>{emails.length}</strong> emails
          </div>
          <div className="stat-chip">
            <strong>{unread}</strong> unread
          </div>
          {urgent > 0 && (
            <div className="stat-chip hot">
              <strong>{urgent}</strong> urgent
            </div>
          )}
        </div>
      )}

      <div className="filter-bar">
        <select value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">All Accounts</option>
        </select>
        <select value={urgency} onChange={(e) => setUrgency(e.target.value)}>
          <option value="">All Urgency</option>
          <option value="4">High+</option>
          <option value="3">Medium+</option>
        </select>
        <select value={reviewed} onChange={(e) => setReviewed(e.target.value)}>
          <option value="">All</option>
          <option value="false">Unreviewed</option>
          <option value="true">Reviewed</option>
        </select>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="btn btn-ghost" onClick={load}>
          ↻ Refresh
        </button>
        <button className="btn btn-ghost" onClick={manualFetch} disabled={fetching}>
          {fetching ? "⏳ Fetching..." : "⚡ Fetch Now"}
        </button>
      </div>

      <div className="cat-tabs">
        <button
          className={`cat-tab${activeCat === "" ? " active" : ""}`}
          onClick={() => setActiveCat("")}
        >
          All
        </button>
        {categories.map((c) => (
          <button
            key={c}
            className={`cat-tab${activeCat === c ? " active" : ""}`}
            onClick={() => setActiveCat(c)}
          >
            {c}
          </button>
        ))}
      </div>

      <div>
        {emails.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">◎</div>
            <p>
              No emails yet.
              <br />
              Click <strong>Fetch Now</strong> to pull the latest.
            </p>
          </div>
        ) : (
          groups.map(([d, items]) => (
            <div className="date-group" key={d}>
              <div className="date-label">{formatDateLabel(d)}</div>
              {items.map((s) => (
                <EmailCard
                  key={s.emailId}
                  s={s}
                  onReviewed={(next) => markReviewed(s, next)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </>
  );
}

function EmailCard({
  s,
  onReviewed,
}: {
  s: DisplaySummary;
  onReviewed: (next: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const u = s.displayUrgency ?? s.urgency;
  const time = new Date(s.receivedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const raw = s.from.replace(/<.*>/, "").replace(/"/g, "").trim();
  const initial = (raw.match(/^[A-Za-z]/) || ["?"])[0].toUpperCase();
  const fromName = raw || s.from.split("@")[0];

  return (
    <div
      className={`email-card${s.reviewed ? " reviewed" : ""}${
        expanded ? " expanded" : ""
      }`}
      data-u={u}
      data-email-id={s.emailId}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(".btn")) return;
        setExpanded((x) => !x);
      }}
    >
      <div className="email-card-inner">
        <div className="card-row">
          <div className="sender-avatar" data-u={u}>
            {initial}
          </div>
          <div className="card-content">
            <div className="card-meta">
              <span className="card-from">{fromName}</span>
              <span className="card-time">{time}</span>
            </div>
            <div className="card-subject">{s.subject}</div>
            <div className="card-preview">{s.summary}</div>
            <div className="card-footer">
              <span className={`urgency-badge u${u}`}>{URGENCY_LABELS[u]}</span>
              <span className="account-tag">{s.account}</span>
              {s.category && <span className="account-tag">{s.category}</span>}
              {s.displayUrgency > s.urgency && (
                <span style={{ fontSize: ".58rem", color: "var(--a)", opacity: 0.8 }}>
                  ↑ boosted
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="card-body">
          <p className="card-body-text">{s.summary}</p>
          {s.actionItems?.length > 0 && (
            <ul className="action-items">
              {s.actionItems.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}
          {s.deadlineMentioned && (
            <p
              style={{
                fontSize: ".74rem",
                color: "var(--u4c)",
                marginTop: ".5rem",
                fontWeight: 500,
              }}
            >
              Deadline: {s.deadlineMentioned}
            </p>
          )}
          <div className="urgency-reason">Urgency: {s.urgencyReason}</div>
          <div>
            <a
              href={s.gmailLink}
              target="_blank"
              rel="noreferrer"
              className="btn btn-primary"
            >
              Open in Gmail ↗
            </a>
            <button
              className="btn btn-ghost btn-reviewed"
              onClick={(e) => {
                e.stopPropagation();
                onReviewed(!s.reviewed);
              }}
            >
              {s.reviewed ? "✓ Reviewed" : "Mark Reviewed"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatDateLabel(dateStr: string) {
  const d = new Date(dateStr + "T12:00:00");
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const diff = Math.round((today.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

// ───────────────────────── Urgent panel ─────────────────────────
function UrgentPanel({ api }: { api: Api }) {
  const [items, setItems] = useState<Summary[]>([]);

  const load = useCallback(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const summaries: Summary[] = await api(
      `get-summaries?date=${today}&urgency=4&reviewed=false`
    ).catch(() => []);
    setItems(summaries.slice(0, 3));
  }, [api]);

  useEffect(() => {
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <aside className="urgent-panel">
      <h3 className="panel-title">Top Urgent</h3>
      <div>
        {items.length === 0 ? (
          <p style={{ fontSize: ".8rem", color: "var(--text-muted)" }}>
            No urgent emails today
          </p>
        ) : (
          items.map((s) => (
            <div
              className="urgent-item"
              key={s.emailId}
              onClick={() =>
                document
                  .querySelector(`[data-email-id='${s.emailId}']`)
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              <div>
                <span
                  className={`urgency-badge u${s.urgency}`}
                  style={{ display: "inline-block", marginBottom: ".3rem" }}
                >
                  U{s.urgency}
                </span>
              </div>
              <div className="urgent-sender">{s.from.split("<")[0].trim()}</div>
              <div style={{ fontSize: ".82rem", margin: ".1rem 0" }}>{s.subject}</div>
              <div className="urgent-reason">{s.urgencyReason}</div>
              {s.deadlineMentioned && (
                <div
                  style={{ fontSize: ".78rem", color: "var(--u4c)", marginTop: ".2rem" }}
                >
                  ⏰ {s.deadlineMentioned}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

// ───────────────────────── Digest view ─────────────────────────
const U_COLORS = ["", "#445069", "#60a5fa", "#f59e0b", "#f97316", "#ff4040"];
const U_LABELS = ["", "Minimal", "Low", "Medium", "High", "Critical"];

function DigestView({ api, active }: { api: Api; active: boolean }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [summaries, setSummaries] = useState<Summary[]>([]);

  const load = useCallback(async () => {
    const params = date ? `date=${date}` : "";
    const data: Summary[] = await api(`get-summaries?${params}`).catch(() => []);
    setSummaries(data);
  }, [api, date]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const byCategory: Record<string, Summary[]> = {};
  for (const s of summaries) {
    const cat = s.category || "Uncategorized";
    (byCategory[cat] ??= []).push(s);
  }
  const sorted = Object.entries(byCategory).sort(([, a], [, b]) => {
    const sa = a.reduce((x, e) => x + e.urgency, 0);
    const sb = b.reduce((x, e) => x + e.urgency, 0);
    return sb - sa;
  });

  const total = summaries.length;
  const urgent = summaries.filter((s) => s.urgency >= 4).length;
  const unread = summaries.filter((s) => !s.reviewed).length;

  return (
    <>
      <div className="digest-header">
        <div>
          <h2 className="digest-title">Daily Digest</h2>
          <p className="digest-sub">Emails grouped by category</p>
        </div>
        <input
          type="date"
          className="digest-date-pick"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>

      {summaries.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">◎</div>
          <p>
            No emails for this date.
            <br />
            Try Fetch Now from Inbox first.
          </p>
        </div>
      ) : (
        <>
          <div className="digest-stats">
            <div className="dstat">
              <div className="dstat-n">{total}</div>
              <div className="dstat-l">Total</div>
            </div>
            <div className="dstat">
              <div className="dstat-n" style={{ color: "var(--u5c)" }}>
                {urgent}
              </div>
              <div className="dstat-l">Urgent</div>
            </div>
            <div className="dstat">
              <div className="dstat-n">{unread}</div>
              <div className="dstat-l">Unread</div>
            </div>
            <div className="dstat">
              <div className="dstat-n">{sorted.length}</div>
              <div className="dstat-l">Categories</div>
            </div>
          </div>
          <div className="digest-grid">
            {sorted.map(([cat, emails]) => (
              <DigestCard key={cat} cat={cat} emails={emails} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function DigestCard({ cat, emails }: { cat: string; emails: Summary[] }) {
  const urgent = emails.filter((e) => e.urgency >= 4);
  const preview = emails.slice(0, 4);
  const rest = emails.length - preview.length;
  return (
    <div className="digest-card">
      <div className="digest-card-header">
        <div className="digest-cat-name">{cat}</div>
        <div className="digest-cat-count">{emails.length}</div>
      </div>
      {urgent.length > 0 && (
        <div className="digest-alert">
          <span style={{ color: "var(--u5c)", fontSize: ".7rem", fontWeight: 700 }}>
            {urgent.length} urgent
          </span>
        </div>
      )}
      <div className="digest-email-list">
        {preview.map((e) => (
          <div
            className="digest-email-row"
            key={e.emailId}
            title={e.subject}
            onClick={() => e.gmailLink && window.open(e.gmailLink, "_blank")}
          >
            <span
              className="digest-dot"
              style={{ background: U_COLORS[e.urgency] }}
            />
            <span className="digest-row-subject">{e.subject}</span>
            <span className={`digest-row-badge u${e.urgency}`}>
              {U_LABELS[e.urgency]}
            </span>
          </div>
        ))}
        {rest > 0 && <div className="digest-more">+{rest} more</div>}
      </div>
    </div>
  );
}

// ───────────────────────── Urgency view ─────────────────────────
type Factor = {
  id: string;
  label: string;
  desc: string;
  locked: boolean;
  enabled: boolean;
  boost: string;
};
const DEFAULT_FACTORS: Factor[] = [
  { id: "aiScore", label: "AI Score", desc: "Base score assigned by AI (1–5)", locked: true, enabled: true, boost: "base" },
  { id: "vipBoost", label: "VIP Sender", desc: "Emails from your VIP list", locked: false, enabled: true, boost: "+1" },
  { id: "recencyBoost", label: "Received Today", desc: "Emails that arrived today", locked: false, enabled: false, boost: "+1" },
  { id: "deadlineBoost", label: "Has Deadline", desc: "AI detected a deadline", locked: false, enabled: false, boost: "+1" },
  { id: "replyBoost", label: "Requires Reply", desc: "AI says a reply is needed", locked: false, enabled: false, boost: "+1" },
];
const URGENCY_SCALE = [
  { u: 1, label: "Minimal", desc: "Newsletters, promos, FYI only", color: "#445069" },
  { u: 2, label: "Low", desc: "Informational, no action needed", color: "#60a5fa" },
  { u: 3, label: "Medium", desc: "Action needed but no hard deadline", color: "#f59e0b" },
  { u: 4, label: "High", desc: "Deadline this week or VIP sender", color: "#f97316" },
  { u: 5, label: "Critical", desc: "Urgent + VIP + deadline today", color: "#ff4040" },
];

function UrgencyView() {
  const [factors, setFactors] = useState<Factor[]>(DEFAULT_FACTORS);
  const [saved, setSaved] = useState(false);
  const dragId = useRef<string | null>(null);

  useEffect(() => {
    try {
      const stored: Record<string, boolean> = JSON.parse(
        localStorage.getItem("urgencyFactors") ?? "{}"
      );
      setFactors(DEFAULT_FACTORS.map((f) => ({ ...f, enabled: stored[f.id] ?? f.enabled })));
    } catch {
      /* keep defaults */
    }
  }, []);

  const toggle = (id: string) =>
    setFactors((prev) =>
      prev.map((f) => (f.id === id ? { ...f, enabled: !f.enabled } : f))
    );

  const save = () => {
    const obj: Record<string, boolean> = {};
    factors.forEach((f) => (obj[f.id] = f.enabled));
    localStorage.setItem("urgencyFactors", JSON.stringify(obj));
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const onDrop = (targetId: string) => {
    const from = dragId.current;
    dragId.current = null;
    if (!from || from === targetId) return;
    setFactors((prev) => {
      const arr = [...prev];
      const fromIdx = arr.findIndex((f) => f.id === from);
      const toIdx = arr.findIndex((f) => f.id === targetId);
      if (arr[toIdx].locked) return prev;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      return arr;
    });
  };

  return (
    <div className="uv-wrap">
      <div className="uv-head">
        <h2 className="uv-title">Urgency Scoring</h2>
        <p className="uv-sub">
          Configure how emails are ranked in your inbox. Drag factors to reorder
          priority.
        </p>
      </div>

      <div className="uv-section">
        <div className="uv-section-label">Urgency Scale</div>
        <div className="uv-scale">
          {URGENCY_SCALE.map((s) => (
            <div className="uv-scale-item" key={s.u}>
              <div
                className="uv-scale-pill"
                style={{
                  background: `${s.color}20`,
                  color: s.color,
                  border: `1px solid ${s.color}33`,
                }}
              >
                <span className="uv-scale-n">{s.u}</span>
                <span className="uv-scale-lbl">{s.label}</span>
              </div>
              <div className="uv-scale-desc">{s.desc}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="uv-section">
        <div className="uv-section-label">
          Scoring Factors{" "}
          <span
            style={{
              color: "var(--t3)",
              fontWeight: 400,
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            — drag to reorder priority
          </span>
        </div>
        <div className="factor-list">
          {factors.map((f) => (
            <div
              key={f.id}
              className={`factor-item${f.locked ? " factor-locked" : ""}`}
              draggable={!f.locked}
              onDragStart={() => (dragId.current = f.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(f.id)}
            >
              <div className="factor-drag">{f.locked ? "⊘" : "⠿"}</div>
              <div className="factor-info">
                <div className="factor-name">{f.label}</div>
                <div className="factor-desc">{f.desc}</div>
              </div>
              <div className="factor-boost">{f.boost}</div>
              <label
                className={`factor-toggle${f.locked ? " factor-toggle-locked" : ""}`}
              >
                <input
                  type="checkbox"
                  className="factor-check"
                  checked={f.enabled}
                  disabled={f.locked}
                  onChange={() => toggle(f.id)}
                />
                <span className="factor-slider" />
              </label>
            </div>
          ))}
        </div>
        <button className="btn btn-primary" style={{ marginTop: ".25rem" }} onClick={save}>
          Save Preferences
        </button>
        {saved && (
          <div style={{ fontSize: ".78rem", color: "var(--a)", marginTop: ".5rem" }}>
            Saved! Inbox will re-rank on next refresh.
          </div>
        )}
      </div>

      <div className="uv-section">
        <div className="uv-section-label">How It Works</div>
        <div className="uv-howto">
          {[
            "AI reads each email and assigns a base score (1–5)",
            "Enabled boost factors add +1 to the display score (max 5)",
            "Emails in Inbox are sorted by final score, newest first within same score",
            "Boosts apply to display only — the stored AI score never changes",
          ].map((step, i) => (
            <div className="uv-step" key={i}>
              <span className="uv-step-n">{i + 1}</span>
              {step}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Settings view ─────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SafeConfig = any;
type AccountHealth = {
  index: number;
  label: string;
  email?: string;
  ok: boolean;
  needsReconnect: boolean;
  error?: string;
  code?: string;
};

function SettingsView({
  api,
  active,
  secret,
}: {
  api: Api;
  active: boolean;
  secret: string;
}) {
  const [config, setConfig] = useState<SafeConfig | null>(null);
  const [error, setError] = useState(false);
  const [vips, setVips] = useState<{ name: string; email: string; global?: boolean }[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [vipName, setVipName] = useState("");
  const [vipEmail, setVipEmail] = useState("");
  const [newCat, setNewCat] = useState("");
  // notification fields
  const [tgEnabled, setTgEnabled] = useState(false);
  const [tgToken, setTgToken] = useState("");
  const [tgChatId, setTgChatId] = useState("");
  const [waEnabled, setWaEnabled] = useState(false);
  const [waSid, setWaSid] = useState("");
  const [waToken, setWaToken] = useState("");
  const [waPhone, setWaPhone] = useState("");
  const [digestTimes, setDigestTimes] = useState("");
  const [accountHealth, setAccountHealth] = useState<AccountHealth[]>([]);

  const load = useCallback(async () => {
    const c = await api("get-settings").catch(() => null);
    if (!c) {
      setError(true);
      return;
    }
    setError(false);
    setConfig(c);
    setVips([...c.vipSenders]);
    setCats([...c.categories]);
    setTgEnabled(c.notifications.telegram.enabled);
    setTgChatId(c.notifications.telegram.chatId === "***" ? "" : c.notifications.telegram.chatId ?? "");
    setWaEnabled(c.notifications.whatsapp.enabled);
    setWaPhone(c.notifications.whatsapp.userPhone ?? "");
    setDigestTimes(c.notifications.digestTimes.join(", "));
    api("check-accounts")
      .then((r) => setAccountHealth(Array.isArray(r.accounts) ? r.accounts : []))
      .catch(() => setAccountHealth([]));
  }, [api]);

  useEffect(() => {
    if (!active) return;
    load();
  }, [active, load]);

  const saveVips = (next: typeof vips) =>
    api("update-settings", { method: "POST", body: JSON.stringify({ vipSenders: next }) });
  const saveCats = (next: string[]) =>
    api("update-settings", { method: "POST", body: JSON.stringify({ categories: next }) });

  const addVip = () => {
    if (!vipEmail.trim()) return;
    const next = [...vips, { name: vipName.trim(), email: vipEmail.trim(), global: true }];
    setVips(next);
    saveVips(next);
    setVipName("");
    setVipEmail("");
  };
  const removeVip = (i: number) => {
    const next = vips.filter((_, idx) => idx !== i);
    setVips(next);
    saveVips(next);
  };
  const addCat = () => {
    const val = newCat.trim();
    if (!val || cats.includes(val)) return;
    const next = [...cats, val];
    setCats(next);
    saveCats(next);
    setNewCat("");
  };
  const removeCat = (i: number) => {
    const next = cats.filter((_, idx) => idx !== i);
    setCats(next);
    saveCats(next);
  };
  const removeAccount = async (i: number) => {
    if (!(await confirmDialog("Remove this Gmail account?", { confirmLabel: "Remove", danger: true }))) return;
    const accounts = config.accounts.filter((_: unknown, idx: number) => idx !== i);
    await api("update-settings", { method: "POST", body: JSON.stringify({ accounts }) });
    load();
  };
  const gmailAuthUrl = (label: string, index: number) =>
    `/api/mail/auth-gmail?label=${encodeURIComponent(label)}&index=${index}&secret=${encodeURIComponent(secret)}`;
  const gmailQrUrl = (label: string, index: number) =>
    `/api/mail/auth-qr?label=${encodeURIComponent(label)}&index=${index}&secret=${encodeURIComponent(secret)}`;
  const connectGmail = (labelArg?: string, indexArg?: number) => {
    const label = labelArg || newLabel.trim() || "Account";
    const index = indexArg ?? config.accounts.length;
    window.location.href = gmailAuthUrl(label, index);
  };

  const saveNotif = async () => {
    const times = digestTimes.split(",").map((t) => t.trim()).filter(Boolean);
    await api("update-settings", {
      method: "POST",
      body: JSON.stringify({
        notifications: {
          telegram: {
            enabled: tgEnabled,
            botToken: tgToken || undefined,
            chatId: tgChatId,
          },
          whatsapp: {
            enabled: waEnabled,
            twilioSid: waSid || undefined,
            twilioToken: waToken || undefined,
            userPhone: waPhone,
          },
          digestTimes: times,
        },
      }),
    });
    notify("Notification settings saved.", "success");
  };

  const testNotif = async (channel: "telegram" | "whatsapp") => {
    const res = await api("send-test-notif", {
      method: "POST",
      body: JSON.stringify({ channel }),
    });
    notify(`${channel}: ${res[channel]}`, "info");
  };

  if (error)
    return (
      <>
        <h2 style={{ marginBottom: "1rem" }}>Settings</h2>
        <p style={{ color: "var(--text-muted)" }}>
          Could not load settings. Check your DASHBOARD_SECRET.
        </p>
      </>
    );
  if (!config)
    return (
      <>
        <h2 style={{ marginBottom: "1rem" }}>Settings</h2>
      </>
    );

  return (
    <>
      <h2 style={{ marginBottom: "1rem" }}>Settings</h2>

      <div className="settings-section">
        <div className="settings-inner">
          <h3>Gmail Accounts</h3>
          <div>
            {config.accounts.length ? (
              config.accounts.map((a: { label: string; email?: string }, i: number) => {
                const health = accountHealth.find((h) => h.index === i);
                const needsReconnect = health?.needsReconnect;
                return (
                  <div key={i} style={{ marginBottom: "0.75rem" }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                        marginBottom: needsReconnect ? "0.55rem" : 0,
                      }}
                    >
                      <span className="account-tag" style={{ flexShrink: 0 }}>
                        {a.label}
                      </span>
                      <span
                        style={{
                          fontSize: "0.85rem",
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {a.email ?? "unknown"}
                      </span>
                      {needsReconnect && (
                        <button
                          className="btn btn-primary"
                          style={{ padding: "0.2rem 0.55rem", fontSize: "0.8rem", flexShrink: 0 }}
                          onClick={() => connectGmail(a.label, i)}
                        >
                          Reconnect
                        </button>
                      )}
                      <button
                        className="btn btn-ghost"
                        style={{ padding: "0.2rem 0.5rem", fontSize: "0.8rem", flexShrink: 0 }}
                        onClick={() => removeAccount(i)}
                      >
                        ✕ Remove
                      </button>
                    </div>
                    {needsReconnect && (
                      <div
                        style={{
                          display: "flex",
                          gap: "0.85rem",
                          alignItems: "center",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          padding: "0.75rem",
                          background: "rgba(255,255,255,.03)",
                        }}
                      >
                        <img
                          src={gmailQrUrl(a.label, i)}
                          alt={`Reconnect ${a.label} Gmail QR code`}
                          width={112}
                          height={112}
                          style={{ borderRadius: 6, background: "#fff", padding: 6, flexShrink: 0 }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: "0.9rem", color: "var(--text)" }}>
                            Gmail login expired
                          </div>
                          <p style={{ margin: "0.25rem 0 0", fontSize: "0.82rem", color: "var(--text-muted)" }}>
                            {health?.error || "Scan the QR or use Reconnect to sign in again."}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                No accounts connected yet
              </p>
            )}
          </div>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
            <input
              placeholder="Label (e.g. Work)"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                color: "var(--text)",
                padding: "0.4rem",
                borderRadius: "6px",
              }}
            />
            <button className="btn btn-primary" onClick={() => connectGmail()}>
              + Connect Gmail Account
            </button>
            {newLabel.trim() && (
              <img
                src={gmailQrUrl(newLabel.trim(), config.accounts.length)}
                alt="Connect Gmail QR code"
                width={96}
                height={96}
                style={{ borderRadius: 6, background: "#fff", padding: 6 }}
              />
            )}
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-inner">
          <h3>
            VIP Senders{" "}
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
              (urgency +1)
            </span>
          </h3>
          <div>
            {vips.length ? (
              vips.map((v, i) => (
                <div
                  key={i}
                  style={{ display: "flex", gap: "0.5rem", marginBottom: "0.4rem", alignItems: "center" }}
                >
                  <span style={{ fontSize: "0.85rem", flex: 1 }}>
                    {v.name} &lt;{v.email}&gt;
                  </span>
                  <button
                    className="btn btn-ghost"
                    style={{ padding: "0.2rem 0.5rem" }}
                    onClick={() => removeVip(i)}
                  >
                    ✕
                  </button>
                </div>
              ))
            ) : (
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                No VIP senders yet
              </p>
            )}
          </div>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
            <input
              placeholder="Name"
              value={vipName}
              onChange={(e) => setVipName(e.target.value)}
              style={{ flex: 1, minWidth: 100, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", padding: "0.4rem", borderRadius: "6px" }}
            />
            <input
              placeholder="email@example.com"
              value={vipEmail}
              onChange={(e) => setVipEmail(e.target.value)}
              style={{ flex: 2, minWidth: 160, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", padding: "0.4rem", borderRadius: "6px" }}
            />
            <button className="btn btn-primary" onClick={addVip}>
              Add
            </button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-inner">
          <h3>Categories</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.75rem" }}>
            {cats.map((c, i) => (
              <span
                key={i}
                style={{ background: "var(--border)", padding: "0.2rem 0.6rem", borderRadius: "4px", fontSize: "0.85rem" }}
              >
                {c}
                <button
                  onClick={() => removeCat(i)}
                  style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: "0.75rem", marginLeft: "0.2rem" }}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input
              placeholder="New category"
              value={newCat}
              onChange={(e) => setNewCat(e.target.value)}
              style={{ flex: 1, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", padding: "0.4rem", borderRadius: "6px" }}
            />
            <button className="btn btn-primary" onClick={addCat}>
              Add
            </button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-inner">
          <h3>Notifications</h3>
          <div className="form-group">
            <label className="toggle">
              <input
                type="checkbox"
                checked={tgEnabled}
                onChange={(e) => setTgEnabled(e.target.checked)}
              />
              Enable Telegram
            </label>
          </div>
          <div className="form-group">
            <label>Telegram Bot Token</label>
            <input
              type="password"
              placeholder="Leave blank to keep existing"
              value={tgToken}
              onChange={(e) => setTgToken(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Telegram Chat ID</label>
            <input value={tgChatId} onChange={(e) => setTgChatId(e.target.value)} />
          </div>

          <div className="form-group" style={{ marginTop: "1rem" }}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={waEnabled}
                onChange={(e) => setWaEnabled(e.target.checked)}
              />
              Enable WhatsApp (Twilio)
            </label>
          </div>
          <div className="form-group">
            <label>Twilio Account SID</label>
            <input
              type="password"
              placeholder="Leave blank to keep existing"
              value={waSid}
              onChange={(e) => setWaSid(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Twilio Auth Token</label>
            <input
              type="password"
              placeholder="Leave blank to keep existing"
              value={waToken}
              onChange={(e) => setWaToken(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>Your WhatsApp Number (with country code, e.g. +601...)</label>
            <input value={waPhone} onChange={(e) => setWaPhone(e.target.value)} />
          </div>

          <div className="form-group" style={{ marginTop: "1rem" }}>
            <label>Digest Times (Singapore time, comma-separated, e.g. 07:00, 19:00)</label>
            <input value={digestTimes} onChange={(e) => setDigestTimes(e.target.value)} />
          </div>

          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={saveNotif}>
              Save Notifications
            </button>
            <button className="btn btn-ghost" onClick={() => testNotif("telegram")}>
              Test Telegram
            </button>
            <button className="btn btn-ghost" onClick={() => testNotif("whatsapp")}>
              Test WhatsApp
            </button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-inner">
          <h3>Polling</h3>
          <div className="form-group">
            <label>Check for new emails every</label>
            <select defaultValue={config.pollingIntervalMin}>
              {[10, 15, 20, 30].map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </select>
          </div>
          <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
            Note: actual schedule is set in vercel.json (cron). This is informational.
          </p>
        </div>
      </div>
    </>
  );
}
