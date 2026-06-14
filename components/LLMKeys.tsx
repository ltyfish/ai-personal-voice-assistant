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
};

// Compact token count: 1234 -> "1.2k", 1_500_000 -> "1.5M".
function fmtTok(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export default function LLMKeys() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [usageModels, setUsageModels] = useState<UsageModel[]>([]);
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
  type RouterCfg = { timeoutMs: number };
  type RouterLimits = { timeoutMs: { min: number; max: number } };
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
      if (res.ok) setUsageModels(Array.isArray(data.models) ? data.models : []);
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

  async function toggleModel(m: UsageModel) {
    const id = `${m.platform}/${m.model}`;
    setModelBusy(id);
    try {
      await fetch("/api/llm-models", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: m.platform, model: m.model, enabled: !m.enabled }),
      });
      await loadUsage();
    } finally {
      setModelBusy(null);
    }
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
          <p style={{ opacity: 0.7, fontSize: 12.5, marginTop: 0, lineHeight: 1.5 }}>
            Per-call timeout for each upstream attempt before the router moves on.
          </p>
          {routerCfg && routerLimits ? (
            <label style={{ display: "block", fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span>Per-call timeout</span>
                <span className="mono" style={{ opacity: 0.8 }}>{Math.round(routerCfg.timeoutMs / 1000)}s</span>
              </div>
              <input
                type="range"
                min={routerLimits.timeoutMs.min}
                max={routerLimits.timeoutMs.max}
                step={1000}
                value={routerCfg.timeoutMs}
                disabled={routerBusy}
                onChange={(e) => setRouterCfg({ ...routerCfg, timeoutMs: Number(e.target.value) })}
                onMouseUp={(e) => saveRouterCfg({ timeoutMs: Number((e.target as HTMLInputElement).value) })}
                onTouchEnd={(e) => saveRouterCfg({ timeoutMs: Number((e.target as HTMLInputElement).value) })}
                style={{ width: "100%" }}
              />
            </label>
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
                <code style={{ minWidth: 130, fontFamily: "var(--font-mono)" }}>{k.maskedKey}</code>
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
                <span style={{ marginLeft: "auto", display: "flex", gap: 12 }}>
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
                    (m.enabled ? " Included in auto rotation." : " Disabled: skipped by auto rotation.");
                  return (
                    <div key={m.model} title={title}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 6px", fontSize: 12.5,
                        opacity: m.enabled ? (m.totalTokens ? 1 : 0.7) : 0.38 }}>
                      <span style={{ flex: 1, wordBreak: "break-all" }}>{m.model}</span>
                      {m.source === "fallback" && <span style={{ fontSize: 11, color: "var(--t2)" }}>fallback</span>}
                      {!m.enabled && <span style={{ fontSize: 11, color: "var(--u4c)" }}>disabled</span>}
                      {m.dayCap ? (
                        <div style={{ width: 90, height: 5, borderRadius: 3, background: "var(--a-dim)", overflow: "hidden" }}
                          title={`${Math.round(pct)}% of today's budget used`}>
                          <div style={{ width: `${pct}%`, height: "100%",
                            background: pct >= 90 ? "var(--u5c)" : pct >= 60 ? "var(--u4c)" : "var(--t1)" }} />
                        </div>
                      ) : null}
                      <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 150, textAlign: "right", opacity: 0.9 }}>
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
                        style={{ ...linkBtn, minWidth: 44, textAlign: "right" }}
                        title={m.enabled ? "Disable this model from auto rotation" : "Enable this model in auto rotation"}
                      >
                        {modelBusy === modelId ? "..." : m.enabled ? "disable" : "enable"}
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
