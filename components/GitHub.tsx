"use client";

// GitHub tab: configured-repo pull requests + CI status, summarized/reviewed by
// the rotating model router, plus a Project Health panel (URL pings + this app's
// own self-health). All server-side (no bridge), so it works deployed and local.
// The same capabilities are exposed to JARVIS as voice tools (lib/tools.ts:
// github_prs / github_status / github_pr_review / health_status).

import { useCallback, useEffect, useState } from "react";
import { notify, confirmDialog } from "@/lib/toast";

type RepoRef = { owner: string; repo: string };
type PrStatus = { state: string; checks: { name: string; conclusion: string }[] };
type PullRequest = {
  number: number; title: string; author: string; headRef: string; baseRef: string;
  draft: boolean; url: string; updatedAt: string; repo: string; status: PrStatus;
};
type RepoHealth = { repo: string; defaultBranch: string; ci: string; pushedAt: string; openIssues: number; openPrs: number; failingChecks: string[]; error?: string };
type HealthCheck = { id: string; name: string; url: string; method: string; expectStatus?: number };
type CheckResult = { id: string; name: string; url: string; ok: boolean; status: number | null; latencyMs: number | null; error?: string; checkedAt: string };
type SelfHealth = { ok: boolean; time: string; db: boolean; env: { name: string; present: boolean }[] };

function timeAgo(iso: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
}

function statusColor(state: string): string {
  if (state === "success") return "#4ade80";
  if (state === "failure" || state === "error") return "#f87171";
  if (state === "pending") return "#fbbf24";
  return "var(--t2)";
}
function statusIcon(state: string): string {
  if (state === "success") return "✓";
  if (state === "failure" || state === "error") return "✗";
  if (state === "pending") return "•";
  return "–";
}

export default function GitHub() {
  // token
  const [tokenInfo, setTokenInfo] = useState<{ hasToken: boolean; masked: string; fromEnv: boolean } | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  // repos
  const [repos, setRepos] = useState<RepoRef[]>([]);
  const [repoInput, setRepoInput] = useState("");
  // PRs
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [prErrors, setPrErrors] = useState<string[]>([]);
  const [prLoading, setPrLoading] = useState(false);
  // repo health (PR-free signals)
  const [health, setHealth] = useState<RepoHealth[]>([]);
  const [healthLoading, setHealthLoading] = useState(false);
  const [summary, setSummary] = useState<Record<string, { busy: boolean; text?: string; mode?: string }>>({});
  // health
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [results, setResults] = useState<CheckResult[]>([]);
  const [self, setSelf] = useState<SelfHealth | null>(null);
  const [hcName, setHcName] = useState("");
  const [hcUrl, setHcUrl] = useState("");
  const [hcBusy, setHcBusy] = useState(false);

  const loadToken = useCallback(async () => {
    try {
      const r = await fetch("/api/github/token", { cache: "no-store" });
      setTokenInfo(await r.json());
    } catch { /* ignore */ }
  }, []);
  const loadRepos = useCallback(async () => {
    try {
      const r = await fetch("/api/github/repos", { cache: "no-store" });
      const d = await r.json();
      setRepos(Array.isArray(d.repos) ? d.repos : []);
    } catch { /* ignore */ }
  }, []);
  const loadPrs = useCallback(async () => {
    setPrLoading(true);
    try {
      const r = await fetch("/api/github/prs", { cache: "no-store" });
      const d = await r.json();
      setPrs(Array.isArray(d.prs) ? d.prs : []);
      setPrErrors(Array.isArray(d.errors) ? d.errors : []);
    } catch { /* ignore */ } finally { setPrLoading(false); }
  }, []);
  const loadRepoHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const r = await fetch("/api/github/health", { cache: "no-store" });
      const d = await r.json();
      setHealth(Array.isArray(d.repos) ? d.repos : []);
    } catch { /* ignore */ } finally { setHealthLoading(false); }
  }, []);
  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health/checks", { cache: "no-store" });
      const d = await r.json();
      setChecks(Array.isArray(d.checks) ? d.checks : []);
      setResults(Array.isArray(d.results) ? d.results : []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadToken(); loadRepos(); loadHealth(); }, [loadToken, loadRepos, loadHealth]);
  useEffect(() => { if (tokenInfo?.hasToken && repos.length) { loadPrs(); loadRepoHealth(); } }, [tokenInfo?.hasToken, repos.length, loadPrs, loadRepoHealth]);

  async function saveToken() {
    const token = tokenInput.trim();
    if (!token) return;
    const r = await fetch("/api/github/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    if (r.ok) { setTokenInput(""); await loadToken(); notify("GitHub token saved.", "success"); }
    else notify("Couldn't save the token.", "error");
  }
  async function clearToken() {
    if (!(await confirmDialog("Remove the stored GitHub token?", { confirmLabel: "Remove", danger: true }))) return;
    await fetch("/api/github/token", { method: "DELETE" });
    loadToken();
  }
  async function addRepo() {
    const full = repoInput.trim();
    if (!full.includes("/")) { notify("Use owner/repo format.", "error"); return; }
    const r = await fetch("/api/github/repos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full }) });
    const d = await r.json();
    if (r.ok) { setRepoInput(""); setRepos(d.repos || []); loadPrs(); }
    else notify(d.error || "Couldn't add repo.", "error");
  }
  async function removeRepo(rp: RepoRef) {
    const r = await fetch(`/api/github/repos?owner=${encodeURIComponent(rp.owner)}&repo=${encodeURIComponent(rp.repo)}`, { method: "DELETE" });
    const d = await r.json();
    setRepos(d.repos || []);
    loadPrs();
  }
  async function summarize(pr: PullRequest, mode: "summary" | "review") {
    const key = `${pr.repo}#${pr.number}`;
    setSummary((s) => ({ ...s, [key]: { busy: true } }));
    const [owner, repo] = pr.repo.split("/");
    try {
      const r = await fetch("/api/github/summarize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner, repo, number: pr.number, mode }) });
      const d = await r.json();
      if (r.ok) setSummary((s) => ({ ...s, [key]: { busy: false, text: d.text, mode } }));
      else { setSummary((s) => ({ ...s, [key]: { busy: false } })); notify(d.error || "Couldn't generate.", "error"); }
    } catch { setSummary((s) => ({ ...s, [key]: { busy: false } })); }
  }

  async function addCheck() {
    if (!hcUrl.trim()) return;
    setHcBusy(true);
    try {
      const r = await fetch("/api/health/checks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: hcName.trim(), url: hcUrl.trim() }) });
      const d = await r.json();
      if (r.ok) { setHcName(""); setHcUrl(""); setChecks(d.checks || []); }
      else notify(d.error || "Couldn't add check.", "error");
    } finally { setHcBusy(false); }
  }
  async function removeCheck(id: string) {
    const r = await fetch(`/api/health/checks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const d = await r.json();
    setChecks(d.checks || []);
  }
  async function runHealth() {
    setHcBusy(true);
    try {
      const r = await fetch("/api/health/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const d = await r.json();
      setResults(Array.isArray(d.results) ? d.results : []);
      setSelf(d.self || null);
    } finally { setHcBusy(false); }
  }

  const resultFor = (id: string) => results.find((r) => r.id === id);

  return (
    <div className="modern-tab" style={{ maxWidth: 860 }}>
      <header className="tab-head">
        <h1>GitHub &amp; Health</h1>
        <p className="tab-sub">Pull requests + CI status for your repos (summarized/reviewed by the rotating models), and project health checks JARVIS can report.</p>
      </header>

      {/* Token */}
      <details className="collapse" open={!tokenInfo?.hasToken}>
        <summary>
          GitHub access
          <span className="col-sub">{tokenInfo?.hasToken ? (tokenInfo.fromEnv ? "env token" : tokenInfo.masked) : "no token"}</span>
          <span className="col-caret" />
        </summary>
        <div className="collapse-body">
          <p style={{ fontSize: 12.5, opacity: 0.7, marginTop: 0, lineHeight: 1.5 }}>
            Paste a fine-grained Personal Access Token (read access to the repos below; Pull requests + Contents). Stored server-side, never shown again.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input className="a-input" placeholder="ghp_… / github_pat_…" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} style={{ flex: 1, minWidth: 240 }} />
            <button className="a-btn" disabled={!tokenInput.trim()} onClick={saveToken}>Save token</button>
            {tokenInfo?.hasToken && !tokenInfo.fromEnv && <button className="a-btn a-btn-ghost" onClick={clearToken}>Remove</button>}
          </div>
        </div>
      </details>

      {/* Repos */}
      <details className="collapse" open>
        <summary>Repositories<span className="col-sub">{repos.length}</span><span className="col-caret" /></summary>
        <div className="collapse-body">
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <input className="a-input" placeholder="owner/repo (e.g. vercel/next.js)" value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addRepo(); }} style={{ flex: 1, minWidth: 0 }} />
            <button className="a-btn" disabled={!repoInput.includes("/")} onClick={addRepo} style={{ flexShrink: 0 }}>Add</button>
          </div>
          {repos.length === 0 ? <p className="tab-sub" style={{ fontSize: 12 }}>None yet — add a repo to track its PRs.</p> : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {repos.map((rp) => (
                <span key={`${rp.owner}/${rp.repo}`} className="a-chip" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {rp.owner}/{rp.repo}
                  <button className="a-btn a-btn-ghost" style={{ padding: "0 6px" }} onClick={() => removeRepo(rp)}>✕</button>
                </span>
              ))}
            </div>
          )}
        </div>
      </details>

      {/* Repo health (useful even with zero open PRs) */}
      <section className="a-card" style={{ marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Repo health</h3>
          <button className="a-btn a-btn-ghost" disabled={healthLoading || !tokenInfo?.hasToken} onClick={loadRepoHealth}>{healthLoading ? "Refreshing…" : "↻ Refresh"}</button>
        </div>
        {!tokenInfo?.hasToken ? (
          <p className="tab-sub">Add a GitHub token above to load repo health.</p>
        ) : health.length === 0 ? (
          <p className="tab-sub">{healthLoading ? "Loading…" : "No repos configured."}</p>
        ) : (
          <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
            {health.map((h) => (
              <div key={h.repo} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--a-dim)" }}>
                <span title={`CI: ${h.error ? "n/a" : h.ci}`} style={{ color: statusColor(h.error ? "" : h.ci), fontWeight: 700 }}>{statusIcon(h.error ? "" : h.ci)}</span>
                <span style={{ minWidth: 160, fontSize: 12.5, fontWeight: 600 }}>{h.repo}</span>
                {h.error ? (
                  <span style={{ flex: 1, fontSize: 11.5, color: "#f87171" }}>{h.error}</span>
                ) : (
                  <span style={{ flex: 1, fontSize: 11.5, opacity: 0.7, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <span>updated {timeAgo(h.pushedAt)}</span>
                    <span>{h.openPrs} PR{h.openPrs === 1 ? "" : "s"}</span>
                    <span>{h.openIssues} issue{h.openIssues === 1 ? "" : "s"}</span>
                    {h.failingChecks.length > 0 && <span style={{ color: "#f87171" }}>failing: {h.failingChecks.slice(0, 3).join(", ")}{h.failingChecks.length > 3 ? "…" : ""}</span>}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* PRs */}
      <section className="a-card" style={{ marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Open pull requests</h3>
          <button className="a-btn a-btn-ghost" disabled={prLoading} onClick={loadPrs}>{prLoading ? "Refreshing…" : "↻ Refresh"}</button>
        </div>
        {prErrors.length > 0 && <p style={{ color: "#f87171", fontSize: 12 }}>{prErrors.join(" · ")}</p>}
        {!tokenInfo?.hasToken ? (
          <p className="tab-sub">Add a GitHub token above to load PRs.</p>
        ) : prs.length === 0 ? (
          <p className="tab-sub">{prLoading ? "Loading…" : "No open PRs across the configured repos."}</p>
        ) : (
          <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
            {prs.map((pr) => {
              const key = `${pr.repo}#${pr.number}`;
              const s = summary[key];
              return (
                <div key={key} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span title={`CI: ${pr.status.state}`} style={{ color: statusColor(pr.status.state), fontWeight: 700 }}>{statusIcon(pr.status.state)}</span>
                    <a href={pr.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600, color: "var(--t1)", textDecoration: "none" }}>{pr.title}</a>
                    {pr.draft && <span className="a-chip">draft</span>}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>
                    {pr.repo} #{pr.number} · {pr.author} · {pr.headRef} → {pr.baseRef}
                    {pr.status.checks.length > 0 && <span> · {pr.status.checks.filter((c) => c.conclusion === "success").length}/{pr.status.checks.length} checks</span>}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button className="a-btn a-btn-ghost" disabled={s?.busy} onClick={() => summarize(pr, "summary")}>{s?.busy && s?.mode !== "review" ? "…" : "Summarize"}</button>
                    <button className="a-btn a-btn-ghost" disabled={s?.busy} onClick={() => summarize(pr, "review")}>{s?.busy && s?.mode === "review" ? "…" : "Review"}</button>
                  </div>
                  {s?.text && (
                    <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: "rgba(0,0,0,0.25)", fontSize: 12.5, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                      <div style={{ opacity: 0.5, fontSize: 11, marginBottom: 4 }}>{s.mode === "review" ? "Review" : "Summary"} (rotating model)</div>
                      {s.text}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Health */}
      <section className="a-card" style={{ marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>Project health</h3>
          <button className="a-btn" disabled={hcBusy} onClick={runHealth}>{hcBusy ? "Running…" : "▶ Run all"}</button>
        </div>

        {self && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12.5 }}>
            <span style={{ color: self.ok ? "#4ade80" : "#f87171", fontWeight: 700 }}>{self.ok ? "●" : "●"}</span>
            <strong>This app</strong>
            <span style={{ opacity: 0.7 }}>db {self.db ? "ok" : "down"} · {self.env.filter((e) => e.present).length}/{self.env.length} env present</span>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, margin: "10px 0" }}>
          <input className="a-input" placeholder="name (optional)" value={hcName} onChange={(e) => setHcName(e.target.value)} style={{ width: 150 }} />
          <input className="a-input" placeholder="https://your-site.com/api/health" value={hcUrl}
            onChange={(e) => setHcUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addCheck(); }} style={{ flex: 1 }} />
          <button className="a-btn" disabled={hcBusy || !hcUrl.trim()} onClick={addCheck}>Add check</button>
        </div>

        {checks.length === 0 ? (
          <p className="tab-sub" style={{ fontSize: 12 }}>No checks yet — add a URL to monitor (e.g. your deployed site or its <code>/api/health</code>).</p>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {checks.map((c) => {
              const r = resultFor(c.id);
              return (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--a-dim)" }}>
                  <span style={{ color: r ? (r.ok ? "#4ade80" : "#f87171") : "var(--t2)", fontWeight: 700 }}>{r ? (r.ok ? "🟢" : "🔴") : "○"}</span>
                  <span style={{ minWidth: 110, fontSize: 12.5 }}>{c.name}</span>
                  <span style={{ flex: 1, fontSize: 11.5, opacity: 0.55, wordBreak: "break-all" }}>{c.url}</span>
                  {r && <span style={{ fontSize: 11.5, opacity: 0.8 }}>{r.status ?? "—"}{r.latencyMs != null ? ` · ${r.latencyMs}ms` : ""}{r.error ? ` · ${r.error}` : ""}</span>}
                  <button className="a-btn a-btn-ghost" style={{ padding: "0 8px" }} onClick={() => removeCheck(c.id)}>✕</button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
