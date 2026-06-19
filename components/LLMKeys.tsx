"use client";

// Slim native Keys tab for the built-in rotating /v1 proxy. Add/remove free-tier
// provider keys, toggle them, and see which are in cooldown. Replaces the
// FreeLLMAPI dashboard for the rotation use-case — fully serverless, keys stored
// in Neon, never shown unmasked.
import { useCallback, useEffect, useState } from "react";
import RouterFeed from "@/components/RouterFeed";
import { openrouterStatus } from "@/lib/bridge";
import { notify, confirmDialog } from "@/lib/toast";

type KeyRow = {
  id: string;
  platform: string;
  label: string;
  maskedKey: string;
  baseUrl: string | null;
  enabled: boolean;
  failCount: number;
  cooledDown: boolean;
};

// One row of the /api/llm-keys/usage model board: combined across every key for
// the provider. `dayCap` is the daily token budget (per-key cap x #keys); the
// remaining bar = dayCap - todayTokens, so it starts full and the rotation's
// recorded usage deducts from it.
type UsageModel = {
  platform: string;
  model: string;
  enabled: boolean;
  source?: string;
  totalTokens: number;
  todayTokens: number;
  requests: number;
  keyCount: number;
  dayCap: number;
  cooledDown?: boolean;
  cooldownUntil?: string | null;
  cooldownDetail?: string | null;
};

// Human duration for the cooldown sliders: ms -> "30s" / "30 min" / "2 h".
function fmtMs(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)}s`;
}

// Compact token count: 1234 -> "1.2k", 1_500_000 -> "1.5M".
function fmtTok(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

// One row of the cross-provider best→worst leaderboard. Includes models whose
// provider has no key yet (so e.g. NVIDIA Maverick can be seen + disabled).
type LeaderRow = {
  platform: string;
  model: string;
  source: string;
  rank: number;
  enabled: boolean;
  hasKey: boolean;
  cooledDown: boolean;
  cooldownUntil: string | null;
  cooldownDetail: string | null;
  todayTokens: number;
  totalTokens: number;
};

export default function LLMKeys() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [usageModels, setUsageModels] = useState<UsageModel[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderRow[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState("groq");
  const [keyVal, setKeyVal] = useState("");
  const [label, setLabel] = useState("");
  // Cloudflare needs the account id (built into a per-key base URL); 'custom'
  // takes a full base URL. Both reuse the key row's base_url column.
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);

  // Rotation knobs persisted server-side so the serverless router reads them.
  // null until loaded.
  type RouterCfg = { timeoutMs: number; cooldownRateLimitMs: number; cooldownClientErrorMs: number; maxKeysPerModel: number };
  type Bound = { min: number; max: number };
  type RouterLimits = { timeoutMs: Bound; cooldownRateLimitMs: Bound; cooldownClientErrorMs: Bound; maxKeysPerModel: Bound };
  const [routerCfg, setRouterCfg] = useState<RouterCfg | null>(null);
  const [routerLimits, setRouterLimits] = useState<RouterLimits | null>(null);
  const [routerBusy, setRouterBusy] = useState(false);
  const [catalogNote, setCatalogNote] = useState("");
  const [modelBusy, setModelBusy] = useState<string | null>(null);

  const loadRouterCfg = useCallback(async () => {
    try {
      const res = await fetch("/api/router-config", { cache: "no-store" });
      const data = await res.json();
      if (data.config) setRouterCfg(data.config);
      if (data.limits) setRouterLimits(data.limits);
    } catch { /* leave defaults unshown */ }
  }, []);

  const saveRouterCfg = useCallback(async (patch: Partial<RouterCfg>) => {
    setRouterBusy(true);
    try {
      const res = await fetch("/api/router-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (data.config) setRouterCfg(data.config);
    } catch { /* ignore */ }
    setRouterBusy(false);
  }, []);

  const syncModelCatalog = useCallback(async () => {
    const status = await openrouterStatus();
    if (!status.ok || !Array.isArray(status.models) || !status.models.length) {
      setCatalogNote(status.error ? `Model catalog not synced: ${status.error}` : "");
      return;
    }
    const res = await fetch("/api/llm-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: status.models.map((m) => ({
          platform: m.platform,
          model: m.modelId,
          displayName: m.displayName,
          enabled: m.enabled,
          contextWindow: m.contextWindow,
          tpdLimit: m.tpdLimit,
          rpdLimit: m.rpdLimit,
          rpmLimit: m.rpmLimit,
          source: "bridge",
        })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    setCatalogNote(res.ok ? `Model catalog synced: ${data.imported ?? status.models.length} models.` : `Model catalog sync failed: ${data.error || res.status}`);
  }, []);

  const needsEndpoint = platform === "cloudflare" || platform === "custom";

  const load = useCallback(async () => {
    const res = await fetch("/api/llm-keys");
    const data = await res.json();
    setKeys(data.keys ?? []);
    setPlatforms(data.platforms ?? []);
    setLoading(false);
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      const res = await fetch("/api/llm-keys/usage", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setUsageModels(Array.isArray(data.models) ? data.models : []);
        setLeaderboard(Array.isArray(data.leaderboard) ? data.leaderboard : []);
      }
    } catch { /* leave as-is */ }
  }, []);

  useEffect(() => {
    load();
    loadRouterCfg();
    // Sync the catalog first so brand-new models appear, then read usage.
    syncModelCatalog().finally(loadUsage);
    const t = setInterval(loadUsage, 30_000);
    return () => clearInterval(t);
  }, [load, loadRouterCfg, syncModelCatalog, loadUsage]);

  // Build the per-key base URL. For cloudflare we accept either a bare account
  // id or a full URL and normalise to the Workers AI OpenAI-compatible endpoint.
  function buildBaseUrl(): string | undefined {
    const v = endpoint.trim();
    if (!needsEndpoint || !v) return undefined;
    if (platform === "custom") return v;
    // cloudflare: a bare account id → full endpoint; a full URL passes through.
    if (/^https?:\/\//i.test(v)) return v;
    return `https://api.cloudflare.com/client/v4/accounts/${v}/ai/v1`;
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!keyVal.trim()) return;
    if (needsEndpoint && !endpoint.trim()) {
      notify(platform === "cloudflare" ? "Cloudflare needs your account id." : "Custom needs a base URL.", "error");
      return;
    }
    setBusy(true);
    await fetch("/api/llm-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, key: keyVal.trim(), label: label.trim(), baseUrl: buildBaseUrl() }),
    });
    setKeyVal("");
    setLabel("");
    setEndpoint("");
    setBusy(false);
    load();
  }

  async function toggle(k: KeyRow) {
    await fetch(`/api/llm-keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !k.enabled }),
    });
    load();
  }

  async function del(k: KeyRow) {
    if (!(await confirmDialog(`Delete this ${k.platform} key (${k.maskedKey})?`, { confirmLabel: "Delete", danger: true }))) return;
    await fetch(`/api/llm-keys/${k.id}`, { method: "DELETE" });
    load();
  }

  async function setModelEnabled(platform: string, model: string, enabled: boolean) {
    const id = `${platform}/${model}`;
    setModelBusy(id);
    try {
      await fetch("/api/llm-models", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, model, enabled }),
      });
      await loadUsage();
    } finally {
      setModelBusy(null);
    }
  }
  const toggleModel = (m: UsageModel) => setModelEnabled(m.platform, m.model, !m.enabled);

  // One router-knob slider: drags update local state, release persists (clamped
  // server-side). Returns null until the config + bounds have loaded.
  function cfgSlider(
    key: keyof RouterCfg, label: string, hint: string, fmt: (v: number) => string, step: number
  ) {
    if (!routerCfg || !routerLimits) return null;
    const lim = routerLimits[key];
    return (
      <label style={{ display: "block", fontSize: 13 }} title={hint}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span>{label}</span>
          <span className="mono" style={{ opacity: 0.8 }}>{fmt(routerCfg[key])}</span>
        </div>
        <input
          type="range"
          min={lim.min}
          max={lim.max}
          step={step}
          value={routerCfg[key]}
          disabled={routerBusy}
          onChange={(e) => setRouterCfg({ ...routerCfg, [key]: Number(e.target.value) })}
          onMouseUp={(e) => saveRouterCfg({ [key]: Number((e.target as HTMLInputElement).value) } as Partial<RouterCfg>)}
          onTouchEnd={(e) => saveRouterCfg({ [key]: Number((e.target as HTMLInputElement).value) } as Partial<RouterCfg>)}
          style={{ width: "100%" }}
        />
      </label>
    );
  }

  // Group by platform for display.
  const grouped: Record<string, KeyRow[]> = {};
  for (const k of keys) (grouped[k.platform] ??= []).push(k);

  // Per-platform model usage (best-first), so each provider lists every free
  // model it serves with a remaining/budget bar under its keys.
  const modelsByPlatform: Record<string, UsageModel[]> = {};
  for (const m of usageModels) (modelsByPlatform[m.platform] ??= []).push(m);

  return (
    <div className="modern-tab llm-keys" style={{ maxWidth: 820 }}>
      <header className="tab-head">
        <h1>LLM Keys</h1>
        <p className="tab-sub">
          Free-tier keys the built-in <code>/v1</code> proxy rotates through. More
          keys per provider means more quota — a rate-limited key cools down and is
          skipped automatically.
        </p>
      </header>

      {/* How to call it — tucked away by default. */}
      <details className="collapse">
        <summary>
          Using the proxy
          <span className="col-caret" />
        </summary>
        <div className="collapse-body" style={{ fontSize: 13, color: "var(--t2)", lineHeight: 1.6 }}>
          Call <code>/v1/chat/completions</code> with{" "}
          <code>model: &quot;&lt;platform&gt;/&lt;model&gt;&quot;</code>. The router
          tries every key for that model before moving to the next model in the chain.
        </div>
      </details>

      {/* Add a key. */}
      <form onSubmit={add} className="llm-add">
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} style={inp}>
          {platforms.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <input
          placeholder="API key"
          value={keyVal}
          onChange={(e) => setKeyVal(e.target.value)}
          style={{ ...inp, flex: 1, minWidth: 220 }}
        />
        {needsEndpoint && (
          <input
            placeholder={platform === "cloudflare" ? "Cloudflare account id" : "base URL"}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            style={{ ...inp, width: 200 }}
          />
        )}
        <input
          placeholder="label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          style={{ ...inp, width: 150 }}
        />
        <button type="submit" disabled={busy} style={btn}>
          {busy ? "Adding…" : "Add key"}
        </button>
      </form>

      {/* Rotation settings — collapsed. */}
      <details className="collapse">
        <summary>
          Rotation settings
          {routerBusy && <span className="col-sub">saving…</span>}
          <span className="col-caret" />
        </summary>
        <div className="collapse-body">
          {routerCfg && routerLimits ? (
            <div style={{ display: "grid", gap: 14 }}>
              {cfgSlider("timeoutMs", "Per-call timeout", "Per-attempt upstream timeout before the router moves on.", (v) => `${Math.round(v / 1000)}s`, 1000)}
              {cfgSlider("maxKeysPerModel", "Keys per model", "Keys tried per model on one call before failing over to the next model (0 = every key).", (v) => (v === 0 ? "all" : String(v)), 1)}
              {cfgSlider("cooldownRateLimitMs", "Rate-limit cooldown", "How long a key/model sits out after a 429/413 before it's retried.", fmtMs, 60_000)}
              {cfgSlider("cooldownClientErrorMs", "Client-error cooldown", "How long a key/model sits out after a non-retryable 4xx (bad model/auth).", fmtMs, 60_000)}
            </div>
          ) : (
            <p style={{ fontSize: 12, opacity: 0.6, margin: 0 }}>Loading…</p>
          )}
          {catalogNote && <p style={{ fontSize: 12, opacity: 0.6, margin: "10px 0 0" }}>{catalogNote}</p>}
        </div>
      </details>

      {/* Live rotation + token feed. */}
      <details className="collapse" open>
        <summary>
          Live rotation
          <span className="col-caret" />
        </summary>
        <div className="collapse-body">
          <RouterFeed />
        </div>
      </details>

      {/* Activity — every assistant turn: what you asked, the tools/decisions it
          ran, and its reply. Powers short-term recall and is clearable. */}
      <details className="collapse">
        <summary>
          Activity
          <span className="col-caret" />
        </summary>
        <div className="collapse-body">
          <ActivityLog />
        </div>
      </details>

      {/* Model leaderboard — best→worst across every provider (the order the auto
          rotation tries them). Includes models whose provider has no key yet, so
          any model can be disabled here even before you add its key. */}
      {leaderboard.length > 0 && (
        <details className="collapse">
          <summary>
            Model leaderboard (best → worst)
            <span className="col-sub">{leaderboard.length} models</span>
            <span className="col-caret" />
          </summary>
          <div className="collapse-body">
            <p style={{ opacity: 0.7, fontSize: 12, marginTop: 0, lineHeight: 1.5 }}>
              The exact order the auto-rotation prefers models. Disable any you don&apos;t want in
              rotation (across the app — voice, pipeline, mail). A model with no key for its
              provider shows <code>no key</code> but can still be pre-disabled.
            </p>
            <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
              {leaderboard.map((m, i) => {
                const id = `${m.platform}/${m.model}`;
                const title =
                  `Rank ${m.rank} · ${m.platform} · ${m.totalTokens.toLocaleString()} tokens all-time` +
                  (m.todayTokens ? `, ${m.todayTokens.toLocaleString()} today` : "") +
                  (m.hasKey ? "" : " · no key for this provider yet") +
                  (m.source === "fallback" ? " · built-in fallback chain" : "") +
                  (m.cooledDown ? " · on cooldown" : "") +
                  (m.enabled ? " · in auto rotation" : " · disabled");
                return (
                  <li key={id} title={title}
                    className={`llm-leader-row${m.enabled ? "" : " is-disabled"}`}>
                    <span className="mono llm-leader-rank">{i + 1}</span>
                    <span className="llm-leader-platform">{m.platform}</span>
                    <span className="llm-leader-model">{m.model}</span>
                    <span className="llm-leader-meta">
                      {m.source === "fallback" && <span style={{ color: "var(--t2)" }}>fallback</span>}
                      {!m.hasKey && <span style={{ color: "var(--u4c)" }}>no key</span>}
                      {m.cooledDown && <span style={{ color: "var(--u4c)" }}>cooldown</span>}
                    </span>
                    <span className="llm-leader-tokens">
                      {m.totalTokens ? `${fmtTok(m.totalTokens)} all` : "-"}
                    </span>
                    {!m.enabled && <span className="llm-disabled-label">disabled</span>}
                    <button type="button" onClick={() => setModelEnabled(m.platform, m.model, !m.enabled)}
                      disabled={modelBusy === id}
                      className={m.enabled ? "llm-action-disable" : "llm-action-enable"}
                      style={{ ...linkBtn, minWidth: 74, textAlign: "center" }}
                      title={m.enabled ? "Disable in auto rotation" : "Enable in auto rotation"}>
                      {modelBusy === id ? "..." : m.enabled ? "Disable" : "Enable"}
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </details>
      )}

      {loading ? (
        <p style={{ color: "var(--t2)" }}>Loading…</p>
      ) : keys.length === 0 ? (
        <p style={{ color: "var(--t2)" }}>No keys yet — add one above.</p>
      ) : (
        Object.entries(grouped).map(([p, rows]) => (
          <details className="collapse" key={p} open>
            <summary>
              {p}
              <span className="col-sub">{rows.length} key{rows.length === 1 ? "" : "s"}</span>
              <span className="col-caret" />
            </summary>
            <div className="collapse-body">
            {rows.map((k) => (
              <div
                key={k.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  borderRadius: 12,
                  background: "var(--a-dim)",
                  border: "1px solid var(--border)",
                  marginBottom: 6,
                  opacity: k.enabled ? 1 : 0.45,
                }}
              >
                <code style={{ flex: "1 1 0", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}>{k.maskedKey}</code>
                {k.label && <span style={{ opacity: 0.6, fontSize: 12 }}>{k.label}</span>}
                {k.baseUrl && (
                  <span style={{ opacity: 0.45, fontSize: 11 }} title={k.baseUrl}>
                    {k.baseUrl.replace(/^https?:\/\//, "").slice(0, 40)}
                  </span>
                )}
                {k.cooledDown && <span style={badge("var(--u4c)")}>cooldown</span>}
                {k.failCount > 0 && !k.cooledDown && (
                  <span style={{ fontSize: 11, opacity: 0.5 }}>{k.failCount} fails</span>
                )}
                <span style={{ marginLeft: "auto", flexShrink: 0, display: "flex", gap: 12 }}>
                  <button onClick={() => toggle(k)} style={linkBtn}>
                    {k.enabled ? "disable" : "enable"}
                  </button>
                  <button onClick={() => del(k)} style={{ ...linkBtn, color: "var(--u5c)" }}>
                    delete
                  </button>
                </span>
              </div>
            ))}

            {/* Per-model token usage for this provider. Budget = per-key daily
                cap x number of keys; the remaining bar deducts as the rotation
                spends tokens (today's usage). All-time used shown alongside. */}
            {(modelsByPlatform[p]?.length ?? 0) > 0 && (
              <div style={{ marginTop: 10, paddingLeft: 2 }}>
                {/* Section subheader — shows key count so the budget-multiplier is obvious. */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, padding: "0 6px" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", opacity: 0.45 }}>
                    Usage per model
                  </span>
                  {(() => {
                    const nk = modelsByPlatform[p][0]?.keyCount ?? 0;
                    return nk > 1 ? (
                      <span style={{ fontSize: 11, opacity: 0.5 }}>
                        ({nk} keys · budgets ×{nk})
                      </span>
                    ) : null;
                  })()}
                </div>
                {modelsByPlatform[p].map((m) => {
                  const remaining = m.dayCap ? Math.max(0, m.dayCap - m.todayTokens) : 0;
                  const pct = m.dayCap ? Math.min(100, (m.todayTokens / m.dayCap) * 100) : 0;
                  const modelId = `${m.platform}/${m.model}`;
                  const title =
                    `Combined across ${m.keyCount} ${m.platform} key${m.keyCount === 1 ? "" : "s"}: ` +
                    `${m.todayTokens.toLocaleString()} used today` +
                    (m.dayCap ? ` of ${m.dayCap.toLocaleString()} daily budget (${remaining.toLocaleString()} left)` : "") +
                    `, ${m.totalTokens.toLocaleString()} tokens all-time, ${m.requests.toLocaleString()} requests.` +
                    (m.source === "fallback" ? " Built-in fallback chain model." : "") +
                    (m.cooledDown
                      ? ` On cooldown until ${m.cooldownUntil ? new Date(m.cooldownUntil).toLocaleTimeString() : "soon"}${m.cooldownDetail ? ` (${m.cooldownDetail})` : ""}; skipped by auto rotation until then.`
                      : "") +
                    (m.enabled ? " Included in auto rotation." : " Disabled: skipped by auto rotation.");
                  return (
                    <div key={m.model} title={title}
                      className={`llm-model-row${m.enabled ? "" : " is-disabled"}${m.totalTokens ? "" : " is-unused"}`}>
                      <span className="llm-model-name">{m.model}</span>
                      <span className="llm-model-badges">
                      {m.source === "fallback" && <span style={{ color: "var(--t2)" }}>fallback</span>}
                      {m.cooledDown && (
                        <span style={{ color: "var(--u4c)" }}
                          title={m.cooldownUntil ? `Cooled until ${new Date(m.cooldownUntil).toLocaleTimeString()}` : "On cooldown"}>
                          cooldown
                        </span>
                      )}
                      {!m.enabled && <span style={{ color: "var(--u4c)" }}>disabled</span>}
                      </span>
                      {m.dayCap ? (
                        <div className="llm-model-bar" style={{ background: "var(--a-dim)" }}
                          title={`${Math.round(pct)}% of today's budget used`}>
                          <div style={{ width: `${pct}%`, height: "100%",
                            background: pct >= 90 ? "var(--u5c)" : pct >= 60 ? "var(--u4c)" : "var(--t1)" }} />
                        </div>
                      ) : null}
                      <span className="llm-model-tokens">
                        {m.dayCap ? (
                          <>
                            <span style={{ color: "var(--t1)" }}>{fmtTok(remaining)}</span>
                            <span style={{ opacity: 0.55 }}>{` left / ${fmtTok(m.dayCap)}`}</span>
                          </>
                        ) : (
                          <span style={{ opacity: 0.6 }}>{m.todayTokens ? `${fmtTok(m.todayTokens)} used` : "—"}</span>
                        )}
                        <span style={{ opacity: 0.4 }}>{` · ${fmtTok(m.totalTokens)} all`}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleModel(m)}
                        disabled={modelBusy === modelId}
                        className={m.enabled ? "llm-action-disable" : "llm-action-enable"}
                        style={{ ...linkBtn, minWidth: 74, textAlign: "center" }}
                        title={m.enabled ? "Disable this model from auto rotation" : "Enable this model in auto rotation"}
                      >
                        {modelBusy === modelId ? "..." : m.enabled ? "Disable" : "Enable"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            </div>
          </details>
        ))
      )}
    </div>
  );
}

// The Activity log: newest-first history of every assistant turn (cloud + local)
// with the tools/decisions it ran, plus a Clear button that wipes the DB table.
type ActivityItem = {
  id: number;
  at: string;
  source: string;
  user: string;
  reply: string;
  model: string | null;
  tools: string[];
  decisions: { name: string; args?: unknown }[];
};

function ActivityLog() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/activity", { cache: "no-store" });
      const data = await res.json();
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch { /* leave as-is */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  async function clear() {
    if (!(await confirmDialog("Clear the entire activity log? This wipes the database history.", { confirmLabel: "Clear", danger: true }))) return;
    setClearing(true);
    try {
      await fetch("/api/activity", { method: "DELETE" });
      setItems([]);
    } finally {
      setClearing(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <p style={{ opacity: 0.7, fontSize: 12, margin: 0, lineHeight: 1.5, flex: 1 }}>
          Every assistant turn — what you asked, the tools &amp; decisions it ran, and its reply.
          The latest few feed short-term recall. {items.length} entr{items.length === 1 ? "y" : "ies"}.
        </p>
        <button type="button" onClick={clear} disabled={clearing || !items.length}
          style={{ ...linkBtn, color: "var(--u5c)" }}>
          {clearing ? "Clearing…" : "Clear all"}
        </button>
      </div>
      {loading ? (
        <p style={{ color: "var(--t2)", fontSize: 13 }}>Loading…</p>
      ) : items.length === 0 ? (
        <p style={{ color: "var(--t2)", fontSize: 13 }}>No activity yet.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {items.map((a) => (
            <li key={a.id}
              style={{ padding: "10px 12px", borderRadius: 12, background: "var(--a-dim)", border: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, opacity: 0.55, marginBottom: 4 }}>
                <span>{new Date(a.at).toLocaleString()}</span>
                <span style={badge(a.source === "local" ? "var(--u4c)" : "var(--t2)")}>{a.source}</span>
                {a.model && <span className="mono">{a.model}</span>}
              </div>
              <div style={{ fontSize: 13, marginBottom: 3 }}>
                <span style={{ opacity: 0.6 }}>You:</span> {a.user || <span style={{ opacity: 0.4 }}>—</span>}
              </div>
              <div style={{ fontSize: 13, marginBottom: a.tools.length ? 6 : 0 }}>
                <span style={{ opacity: 0.6 }}>JARVIS:</span> {a.reply || <span style={{ opacity: 0.4 }}>—</span>}
              </div>
              {a.tools.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {a.decisions.map((d, i) => (
                    <span key={i} className="mono"
                      title={(() => { try { return JSON.stringify(d.args); } catch { return ""; } })()}
                      style={{ fontSize: 11, padding: "2px 8px", borderRadius: 100, background: "var(--bg2)", border: "1px solid var(--border)", opacity: 0.85 }}>
                      {d.name}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const inp: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 12,
  border: "1px solid var(--border)",
  background: "var(--bg2)",
  color: "var(--t1)",
  fontFamily: "var(--font-body)",
};
const btn: React.CSSProperties = {
  padding: "10px 18px",
  borderRadius: 100,
  border: "none",
  cursor: "pointer",
  background: "var(--a)",
  color: "#08080a",
  fontWeight: 600,
  fontFamily: "var(--font-body)",
};
const linkBtn: React.CSSProperties = {
  background: "var(--a-dim)",
  border: "1px solid var(--border)",
  color: "var(--t2)",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 500,
  fontFamily: "var(--font-body)",
  padding: "5px 12px",
  borderRadius: 100,
  transition: "all .35s cubic-bezier(0.32,0.72,0,1)",
};
function badge(color: string): React.CSSProperties {
  return { fontSize: 11, color, border: `1px solid ${color}`, borderRadius: 100, padding: "2px 9px" };
}
