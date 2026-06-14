"use client";

// "Abilities" tab — a simple reference of WHAT Jarvis can do, tagged by where it
// runs: in the cloud, on your computer (local, needs the bridge), or both. Tools
// that ONLY work locally are hidden when the bridge is offline, so you never see
// (or try to use) something the cloud can't do.
//
// Below the list live the "ABOUT ME" memory inputs: website shortcuts, logins and
// per-site startup steps. These are NOT keywords — they're just facts written into
// Jarvis's memory (memory.md). Jarvis reads them every turn and acts on them
// naturally ("open deployment" finds your shortcut, "log into github" uses your
// saved login). Editing them syncs straight into memory. Routing/keyword editing
// is gone — Jarvis figures out the right tool from what you say.

import { useEffect, useState, type CSSProperties } from "react";
import { useLocalPresence } from "@/lib/local-presence";

// Where each capability runs. "both" = works in the cloud and locally; "local" =
// needs your computer (the bridge); "cloud" = cloud-only. Local-only tools are
// hidden when the bridge is offline.
type Where = "both" | "local" | "cloud";

const TOOLS: { label: string; icon: string; blurb: string; where: Where }[] = [
  { label: "Tasks", icon: "✓", blurb: "Add, list, complete, edit and delete to-dos.", where: "both" },
  { label: "Reminders", icon: "🔔", blurb: "Due-dated tasks that alert you before they're due.", where: "both" },
  { label: "Calendar events", icon: "◷", blurb: "Timed events with repeats — add, list, reschedule, delete.", where: "both" },
  { label: "Notes", icon: "✎", blurb: "Quick memos — add, search, edit, delete.", where: "both" },
  { label: "Projects", icon: "🗂", blurb: "Project cards with improvement notes and scheduled time.", where: "both" },
  { label: "Email digest", icon: "✉", blurb: "Read, fetch and mark your connected Gmail summaries.", where: "both" },
  { label: "Music", icon: "♪", blurb: "Play, queue and control Spotify (Premium).", where: "both" },
  { label: "Read a page", icon: "▦", blurb: "Read or summarize a public web page aloud (no browser opened).", where: "cloud" },
  { label: "Message someone", icon: "💬", blurb: "Text someone free via WhatsApp, Telegram or email.", where: "both" },
  { label: "Contacts", icon: "👤", blurb: "Your contacts book — add, list, sync.", where: "both" },
  { label: "Open apps & folders", icon: "📂", blurb: "Open an app or folder on your computer.", where: "local" },
  { label: "Browser control", icon: "🖥", blurb: "Drive your logged-in browser — open, read, click, type.", where: "local" },
  { label: "Run a command", icon: "⌘", blurb: "Developer mode — run a PowerShell command you confirm.", where: "local" },
];

const TAG: Record<Where, { text: string; color: string }> = {
  both: { text: "Cloud + Local", color: "var(--a)" },
  cloud: { text: "Cloud only", color: "#38bdf8" },
  local: { text: "Local only", color: "#f59e0b" },
};

export default function Abilities() {
  const { status: presence, checkedOnce } = useLocalPresence();
  const bridge = presence.bridge;

  // Hide local-only tools until we've confirmed the bridge is up — in the cloud
  // they simply don't exist, so don't tempt the user with them.
  const tools = TOOLS.filter((t) => t.where !== "local" || bridge);

  return (
    <div className="assistant-tab">
      <div className="a-card">
        <div className="a-card-inner">
          <h2>Abilities</h2>
          <p style={{ color: "var(--t2)", marginTop: ".25rem", fontSize: ".9rem", marginBottom: ".4rem" }}>
            Everything Jarvis can do — just say it naturally. Each tool is tagged by
            where it runs: in the <b style={{ color: "var(--a)" }}>cloud</b>, on{" "}
            <b style={{ color: "#f59e0b" }}>your computer</b> (needs the bridge), or both.
          </p>
          <p style={{ color: "var(--t3, var(--t2))", fontSize: ".8rem", margin: 0 }}>
            {checkedOnce && !bridge
              ? "Your computer isn't connected, so computer-only tools (apps, browser, commands) are hidden. Run the bridge on your laptop to unlock them."
              : "Your computer is connected — all tools are available."}
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: ".7rem", marginTop: ".9rem" }}>
            {tools.map((t) => {
              const tag = TAG[t.where];
              return (
                <div key={t.label} style={{ display: "flex", alignItems: "flex-start", gap: ".6rem" }}>
                  <span
                    aria-hidden
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "1.7rem",
                      height: "1.7rem",
                      flexShrink: 0,
                      borderRadius: ".5rem",
                      background: "var(--a-glow, rgba(245,158,11,.15))",
                      color: "var(--a)",
                      fontSize: ".95rem",
                    }}
                  >
                    {t.icon}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: ".9rem", color: "var(--t1)", fontWeight: 600 }}>{t.label}</div>
                    <p style={{ color: "var(--t2)", margin: ".1rem 0 0", fontSize: ".8rem" }}>{t.blurb}</p>
                  </div>
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: ".66rem",
                      fontWeight: 600,
                      padding: ".15rem .45rem",
                      borderRadius: ".4rem",
                      border: `1px solid ${tag.color}`,
                      color: tag.color,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {tag.text}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* "About me" memory inputs — facts Jarvis always reads (synced into
          memory.md). Available everywhere; they're context, not bridge actions. */}
      <div className="a-card" style={{ marginTop: "1rem" }}>
        <div className="a-card-inner">
          <h2 style={{ fontSize: ".95rem" }}>🧠 About me (memory)</h2>
          <p style={{ color: "var(--t2)", marginTop: ".25rem", fontSize: ".85rem", marginBottom: 0 }}>
            Everything below is written into Jarvis's <b style={{ color: "var(--t1)" }}>memory</b> and
            read on every turn — no keywords, no exact phrasing. Jarvis just knows your shortcuts,
            logins and startup steps and uses them when they fit.
          </p>
        </div>
      </div>

      <ShortcutsCard />
      <LoginsCard />
      <StartupCard />
      <NotesCard />
    </div>
  );
}

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: "8rem",
  padding: ".35rem .5rem",
  fontSize: ".82rem",
  borderRadius: ".4rem",
  border: "1px solid var(--border, rgba(255,255,255,.14))",
  background: "var(--bg, rgba(0,0,0,.2))",
  color: "var(--t1)",
};

// ── "About me" memory: shared types + loader ─────────────────────────────────
// These three cards (logins / startups / notes) all read & write /api/memory.
// Saving syncs straight into memory.md; Jarvis reads it as facts, not keywords.
type Login = { host: string; username: string; password: string };
type Startup = { url: string; command: string };
type Memory = { shortcuts: { keyword: string; url: string }[]; logins: Login[]; startups: Startup[]; notes: string };

// POST a partial memory update and return the saved memory (or null on failure).
async function saveMemory(patch: Partial<Pick<Memory, "logins" | "startups" | "notes">>): Promise<Memory | null> {
  try {
    const res = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const d = await res.json();
    return d?.memory ?? null;
  } catch {
    return null;
  }
}

// SAVED LOGINS — site + username + password, stored on the server and written into
// memory.md so Jarvis can sign you in when a site needs it (it drives your real
// browser via the bridge). Plain text in memory — don't use on a shared machine.
function LoginsCard() {
  const [logins, setLogins] = useState<Login[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);

  useEffect(() => {
    fetch("/api/memory", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setLogins(Array.isArray(d?.memory?.logins) ? d.memory.logins : []))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const persist = async (next: Login[]) => {
    setSaving(true);
    const m = await saveMemory({ logins: next });
    if (m) setLogins(m.logins);
    setSaving(false);
  };
  const add = () => {
    const h = host.trim().toLowerCase();
    if (!h || !username.trim()) return;
    void persist([...logins.filter((l) => l.host !== h), { host: h, username: username.trim(), password }]);
    setHost(""); setUsername(""); setPassword("");
  };
  const remove = (h: string) => void persist(logins.filter((l) => l.host !== h));

  return (
    <div className="a-card" style={{ marginTop: "1rem" }}>
      <div className="a-card-inner">
        <h2 style={{ fontSize: ".95rem" }}>🔑 Logins</h2>
        <p style={{ color: "var(--t2)", marginTop: ".25rem", fontSize: ".82rem" }}>
          Sites Jarvis can sign you into. Stored in your memory and used when a page needs a login —
          Jarvis types your username &amp; password into your real browser (you review/submit). It{" "}
          <b style={{ color: "var(--t1)" }}>can’t do Google / Apple / SSO</b> logins. Saved as plain
          text in memory.md — don’t use on a shared computer.
        </p>

        {logins.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: ".4rem", margin: ".6rem 0" }}>
            {logins.map((l) => (
              <div key={l.host} style={{ display: "flex", alignItems: "center", gap: ".5rem", fontSize: ".83rem" }}>
                <span className="a-accent" style={{ fontWeight: 600, minWidth: "8rem" }}>{l.host}</span>
                <span style={{ color: "var(--t2)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {l.username}{l.password ? " · ••••••" : ""}
                </span>
                <button className="icon-x" onClick={() => remove(l.host)} title="Remove" disabled={saving}>✕</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: ".4rem", marginTop: ".5rem", alignItems: "center" }}>
          <input style={inputStyle} value={host} disabled={!loaded || saving} onChange={(e) => setHost(e.target.value)} placeholder="site (e.g. github.com)" />
          <input style={inputStyle} value={username} disabled={!loaded || saving} onChange={(e) => setUsername(e.target.value)} placeholder="username / email" autoComplete="off" />
          <input style={inputStyle} value={password} disabled={!loaded || saving} onChange={(e) => setPassword(e.target.value)} placeholder="password (optional)" type={show ? "text" : "password"} autoComplete="new-password" />
          <label style={{ display: "flex", alignItems: "center", gap: ".25rem", fontSize: ".75rem", color: "var(--t2)" }}>
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> show
          </label>
          <button className="a-btn" onClick={add} disabled={!host.trim() || !username.trim() || saving}>Save</button>
        </div>
      </div>
    </div>
  );
}

// STARTUP STEPS — a per-site instruction Jarvis does right after it opens that site
// in the browser (e.g. "dismiss the cookie banner"). Stored in memory; Jarvis runs
// it itself when it opens the page. No keywords.
function StartupCard() {
  const [startups, setStartups] = useState<Startup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");

  useEffect(() => {
    fetch("/api/memory", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setStartups(Array.isArray(d?.memory?.startups) ? d.memory.startups : []))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const persist = async (next: Startup[]) => {
    setSaving(true);
    const m = await saveMemory({ startups: next });
    if (m) setStartups(m.startups);
    setSaving(false);
  };
  const add = () => {
    const u = url.trim().toLowerCase();
    const c = command.trim();
    if (!u || !c) return;
    void persist([...startups.filter((s) => s.url !== u), { url: u, command: c }]);
    setUrl(""); setCommand("");
  };
  const remove = (u: string) => void persist(startups.filter((s) => s.url !== u));

  return (
    <div className="a-card" style={{ marginTop: "1rem" }}>
      <div className="a-card-inner">
        <h2 style={{ fontSize: ".95rem" }}>▸ Startup steps</h2>
        <p style={{ color: "var(--t2)", marginTop: ".25rem", fontSize: ".82rem" }}>
          What Jarvis should do right after it opens a site in the browser. E.g.{" "}
          <span className="a-accent">app.example.com/dash</span> →{" "}
          <span className="a-accent">“dismiss the cookie banner”</span>. Chain steps with{" "}
          <span className="a-accent">;</span> or <span className="a-accent">then</span>.
        </p>

        {startups.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: ".35rem", margin: ".6rem 0" }}>
            {startups.map((s) => (
              <div key={s.url} style={{ display: "flex", alignItems: "center", gap: ".5rem", fontSize: ".83rem" }}>
                <span style={{ color: "var(--t2)", minWidth: "11rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.url}</span>
                <span className="a-accent" style={{ flex: 1, minWidth: 0 }}>→ {s.command}</span>
                <button className="icon-x" onClick={() => remove(s.url)} title="Remove" disabled={saving}>✕</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: ".5rem", flexWrap: "wrap" }}>
          <input style={{ ...inputStyle, flex: 2 }} value={url} disabled={!loaded || saving} onChange={(e) => setUrl(e.target.value)} placeholder="site url (e.g. app.example.com/dash)" />
          <input style={{ ...inputStyle, flex: 2 }} value={command} disabled={!loaded || saving} onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()} placeholder="startup command (e.g. dismiss the cookie banner)" />
          <button className="a-btn" onClick={add} disabled={!url.trim() || !command.trim() || saving}>Add</button>
        </div>
      </div>
    </div>
  );
}

// FREE-TEXT NOTES about the user — anything Jarvis should always know (preferences,
// who people are, how you like replies). Goes verbatim into memory.md.
function NotesCard() {
  const [notes, setNotes] = useState("");
  const [initial, setInitial] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/memory", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const n = typeof d?.memory?.notes === "string" ? d.memory.notes : "";
        setNotes(n); setInitial(n);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const save = async () => {
    if (notes === initial) return;
    setSaving(true);
    const m = await saveMemory({ notes });
    if (m) { setNotes(m.notes); setInitial(m.notes); }
    setSaving(false);
  };

  return (
    <div className="a-card" style={{ marginTop: "1rem" }}>
      <div className="a-card-inner">
        <h2 style={{ fontSize: ".95rem" }}>📝 Notes about me</h2>
        <p style={{ color: "var(--t2)", marginTop: ".25rem", fontSize: ".82rem", marginBottom: ".5rem" }}>
          Anything Jarvis should always know — your preferences, who people are, how you like replies.
          Saved into memory and read every turn.
        </p>
        <textarea
          className="a-input"
          value={notes}
          disabled={!loaded || saving}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={save}
          rows={4}
          placeholder={"e.g. I'm Lawrence, a student. Keep replies short. My partner is Sam. I work in PST."}
          style={{ ...inputStyle, width: "100%", fontFamily: "inherit", resize: "vertical" }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: ".4rem" }}>
          <button className="a-btn" onClick={save} disabled={notes === initial || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Website SHORTCUTS: keyword → URL the user opens often. Saying the keyword (or
// "open <keyword>") opens the site with no AI. Persisted via /api/shortcuts.
type Shortcut = { keyword: string; url: string };
function ShortcutsCard() {
  const [list, setList] = useState<Shortcut[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [kw, setKw] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/shortcuts", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setList(Array.isArray(d?.shortcuts) ? d.shortcuts : []))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const persist = async (next: Shortcut[]) => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/shortcuts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortcuts: next }),
      });
      const d = await res.json();
      if (Array.isArray(d?.shortcuts)) setList(d.shortcuts);
      else setError(d?.error ?? "Couldn't save.");
    } catch {
      setError("Network error — try again.");
    } finally {
      setSaving(false);
    }
  };

  const add = () => {
    const keyword = kw.trim().toLowerCase();
    const u = url.trim();
    if (!keyword || !u) return;
    const next = [...list.filter((s) => s.keyword !== keyword), { keyword, url: u }];
    setKw("");
    setUrl("");
    void persist(next);
  };
  const remove = (keyword: string) =>
    void persist(list.filter((s) => s.keyword !== keyword));

  return (
    <div className="a-card" style={{ marginTop: "1rem" }}>
      <div className="a-card-inner">
        <h2 style={{ fontSize: ".95rem" }}>Website shortcuts</h2>
        <p style={{ color: "var(--t2)", marginTop: ".25rem", fontSize: ".85rem", marginBottom: ".6rem" }}>
          A word that opens a site you visit often — say it on its own or with “open”.
          E.g. keyword <span className="a-accent">“deployment”</span> →{" "}
          <span className="a-accent">netlify.com/home</span>, then say{" "}
          <span className="a-accent">“deployment”</span>. Opens instantly (no AI).
        </p>

        {list.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: ".35rem", marginBottom: ".6rem" }}>
            {list.map((s) => (
              <div key={s.keyword} style={{ display: "flex", alignItems: "center", gap: ".5rem", fontSize: ".84rem" }}>
                <span className="a-accent" style={{ fontWeight: 600, minWidth: "6rem" }}>{s.keyword}</span>
                <span style={{ color: "var(--t2)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.url}
                </span>
                <button className="icon-x" onClick={() => remove(s.keyword)} title="Remove" disabled={saving}>✕</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: ".5rem", flexWrap: "wrap" }}>
          <input className="a-input" value={kw} disabled={!loaded || saving} onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()} placeholder="keyword (e.g. deployment)" style={inputStyle} />
          <input className="a-input" value={url} disabled={!loaded || saving} onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()} placeholder="url (e.g. netlify.com/home)" style={{ ...inputStyle, flex: 2 }} />
          <button className="a-btn" onClick={add} disabled={!kw.trim() || !url.trim() || saving}>
            {saving ? "Saving…" : "Add"}
          </button>
        </div>
        {error && (
          <p style={{ color: "var(--u4c, #f97316)", fontSize: ".78rem", marginTop: ".4rem", marginBottom: 0 }}>{error}</p>
        )}
      </div>
    </div>
  );
}
