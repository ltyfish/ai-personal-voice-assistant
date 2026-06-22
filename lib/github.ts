// GitHub integration (server-side, bridge-free so it works deployed AND locally).
//
// Auth: a fine-grained Personal Access Token. Stored in the existing mail_kv
// table (namespace "github", key "token") so no schema migration is needed —
// same pattern as Spotify tokens / contacts. Falls back to the GITHUB_TOKEN env
// var when no token is stored. The token is NEVER returned to the client
// unmasked (see maskToken). Configured repos live in mail_kv ("github"/"repos").
//
// Used by: the GitHub tab (components/GitHub.tsx via app/api/github/*) and the
// JARVIS voice tools github_prs / github_status / github_pr_review (lib/tools.ts).
// Summaries/reviews run through the rotating router (lib/llm-router.ts), so the
// same best→worst model rotation the rest of the app uses powers them.

import { and, eq } from "drizzle-orm";
import { db, mailKv } from "@/db";
import { routeChatCompletion } from "./llm-router";

const NS = "github";
const API = "https://api.github.com";
const FETCH_TIMEOUT_MS = 15_000;

// owner / repo / branch sanity (GitHub allows letters, digits, -, _, ., /).
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const REF_RE = /^[A-Za-z0-9_./-]+$/;

export type RepoRef = { owner: string; repo: string };

export type PullRequest = {
  number: number;
  title: string;
  author: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  draft: boolean;
  url: string;
  updatedAt: string;
  repo: string; // "owner/repo" for the cross-repo list
};

export type PrStatus = {
  state: string; // success | failure | pending | error | none
  checks: { name: string; conclusion: string }[];
};

// ── token + repo config (mail_kv) ───────────────────────────────────────────
async function kvGet<T>(key: string): Promise<T | null> {
  const rows = await db
    .select({ value: mailKv.value })
    .from(mailKv)
    .where(and(eq(mailKv.namespace, NS), eq(mailKv.key, key)));
  return rows.length ? (rows[0].value as T) : null;
}

async function kvSet(key: string, value: object): Promise<void> {
  await db
    .insert(mailKv)
    .values({ namespace: NS, key, value })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value, updatedAt: new Date() },
    });
}

export async function getToken(): Promise<string> {
  const v = await kvGet<{ token?: string }>("token");
  return (v?.token || process.env.GITHUB_TOKEN || "").trim();
}

export async function setToken(token: string): Promise<void> {
  await kvSet("token", { token: (token || "").trim() });
}

export async function clearToken(): Promise<void> {
  await kvSet("token", { token: "" });
}

// Show enough to identify the token without exposing it (first 7 + last 4).
export function maskToken(token: string): string {
  const t = (token || "").trim();
  if (!t) return "";
  if (t.length <= 12) return "•".repeat(t.length);
  return `${t.slice(0, 7)}…${t.slice(-4)}`;
}

export async function hasToken(): Promise<boolean> {
  return !!(await getToken());
}

export async function listConfiguredRepos(): Promise<RepoRef[]> {
  const v = await kvGet<{ repos?: RepoRef[] }>("repos");
  return Array.isArray(v?.repos) ? v!.repos : [];
}

export function isValidRepo(owner: string, repo: string): boolean {
  return NAME_RE.test(owner || "") && NAME_RE.test(repo || "");
}

export async function addRepo(owner: string, repo: string): Promise<RepoRef[]> {
  owner = (owner || "").trim();
  repo = (repo || "").trim();
  if (!isValidRepo(owner, repo)) throw new Error("Invalid owner/repo.");
  const repos = await listConfiguredRepos();
  if (!repos.some((r) => r.owner === owner && r.repo === repo)) repos.push({ owner, repo });
  await kvSet("repos", { repos });
  return repos;
}

export async function removeRepo(owner: string, repo: string): Promise<RepoRef[]> {
  const repos = (await listConfiguredRepos()).filter((r) => !(r.owner === owner && r.repo === repo));
  await kvSet("repos", { repos });
  return repos;
}

// ── GitHub REST helper ──────────────────────────────────────────────────────
type GhResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

async function gh<T>(path: string, token?: string): Promise<GhResult<T>> {
  const tok = token ?? (await getToken());
  if (!tok) return { ok: false, status: 401, error: "No GitHub token set. Add a PAT in the GitHub tab." };
  try {
    const res = await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${tok}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "JARVIS-PersonalAI",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = (body as any)?.message || `GitHub ${res.status}`;
      return { ok: false, status: res.status, error: msg };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e: any) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { ok: false, status: 504, error: timedOut ? "GitHub request timed out." : e?.message || "GitHub request failed" };
  }
}

// ── reads ───────────────────────────────────────────────────────────────────
export async function listPullRequests(owner: string, repo: string, token?: string): Promise<GhResult<PullRequest[]>> {
  if (!isValidRepo(owner, repo)) return { ok: false, status: 400, error: "Invalid owner/repo." };
  const r = await gh<any[]>(`/repos/${owner}/${repo}/pulls?state=open&per_page=30`, token);
  if (!r.ok) return r;
  const prs: PullRequest[] = r.data.map((p) => ({
    number: p.number,
    title: p.title,
    author: p.user?.login || "unknown",
    headRef: p.head?.ref || "",
    baseRef: p.base?.ref || "",
    headSha: p.head?.sha || "",
    draft: !!p.draft,
    url: p.html_url,
    updatedAt: p.updated_at,
    repo: `${owner}/${repo}`,
  }));
  return { ok: true, data: prs };
}

// CI status for a commit (combines the legacy commit-status API + check-runs).
export async function getPrStatus(owner: string, repo: string, sha: string, token?: string): Promise<PrStatus> {
  if (!isValidRepo(owner, repo) || !REF_RE.test(sha || "")) return { state: "none", checks: [] };
  const checks: { name: string; conclusion: string }[] = [];
  const runs = await gh<{ check_runs?: any[] }>(`/repos/${owner}/${repo}/commits/${sha}/check-runs`, token);
  if (runs.ok) {
    for (const c of runs.data.check_runs || []) {
      checks.push({ name: c.name, conclusion: c.conclusion || c.status || "pending" });
    }
  }
  const combined = await gh<{ state?: string }>(`/repos/${owner}/${repo}/commits/${sha}/status`, token);
  let state = combined.ok ? combined.data.state || "none" : "none";
  // If there were no legacy statuses but check-runs exist, derive overall state.
  if ((state === "none" || !state) && checks.length) {
    const bad = checks.some((c) => c.conclusion === "failure" || c.conclusion === "timed_out" || c.conclusion === "cancelled");
    const pending = checks.some((c) => c.conclusion === "pending" || c.conclusion === "queued" || c.conclusion === "in_progress");
    state = bad ? "failure" : pending ? "pending" : "success";
  }
  return { state, checks };
}

// All open PRs across the configured repos, each with CI status. Errors per repo
// are swallowed (returned as an empty list) so one bad repo can't break the view.
export async function listAllOpenPrs(token?: string): Promise<{ prs: (PullRequest & { status: PrStatus })[]; errors: string[] }> {
  const tok = token ?? (await getToken());
  const repos = await listConfiguredRepos();
  const out: (PullRequest & { status: PrStatus })[] = [];
  const errors: string[] = [];
  for (const { owner, repo } of repos) {
    const r = await listPullRequests(owner, repo, tok);
    if (!r.ok) { errors.push(`${owner}/${repo}: ${r.error}`); continue; }
    for (const pr of r.data) {
      const status = pr.headSha ? await getPrStatus(owner, repo, pr.headSha, tok) : { state: "none", checks: [] };
      out.push({ ...pr, status });
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { prs: out, errors };
}

// Repo CI/status summary: default-branch latest-commit status. Used by github_status.
export async function getRepoStatus(owner: string, repo: string, token?: string): Promise<GhResult<{ repo: string; defaultBranch: string; openPrs: number; status: PrStatus }>> {
  if (!isValidRepo(owner, repo)) return { ok: false, status: 400, error: "Invalid owner/repo." };
  const tok = token ?? (await getToken());
  const meta = await gh<{ default_branch?: string; open_issues_count?: number }>(`/repos/${owner}/${repo}`, tok);
  if (!meta.ok) return meta;
  const branch = meta.data.default_branch || "main";
  const head = await gh<{ sha?: string }>(`/repos/${owner}/${repo}/commits/${branch}`, tok);
  const status = head.ok && head.data.sha ? await getPrStatus(owner, repo, head.data.sha, tok) : { state: "none", checks: [] };
  const prs = await listPullRequests(owner, repo, tok);
  return {
    ok: true,
    data: { repo: `${owner}/${repo}`, defaultBranch: branch, openPrs: prs.ok ? prs.data.length : 0, status },
  };
}

// ── repo health (PR-free signals: CI on default branch, activity, issues) ─────
export type RepoHealth = {
  repo: string;
  defaultBranch: string;
  ci: string; // success | failure | pending | none
  pushedAt: string; // ISO of last push, or ""
  openIssues: number; // GitHub's open_issues_count INCLUDES open PRs
  openPrs: number;
  failingChecks: string[]; // names of non-success checks on the head commit
  error?: string;
};

// Health for one repo with a minimal set of calls: repo meta (branch, activity,
// issue count) → head commit sha → CI status of that commit. Errors are returned
// in-band so one bad repo never throws the whole list.
export async function getRepoHealth(owner: string, repo: string, token?: string): Promise<RepoHealth> {
  const base: RepoHealth = { repo: `${owner}/${repo}`, defaultBranch: "", ci: "none", pushedAt: "", openIssues: 0, openPrs: 0, failingChecks: [] };
  if (!isValidRepo(owner, repo)) return { ...base, error: "Invalid owner/repo." };
  const tok = token ?? (await getToken());
  const meta = await gh<{ default_branch?: string; open_issues_count?: number; pushed_at?: string }>(`/repos/${owner}/${repo}`, tok);
  if (!meta.ok) return { ...base, error: meta.error };
  const branch = meta.data.default_branch || "main";
  const head = await gh<{ sha?: string }>(`/repos/${owner}/${repo}/commits/${branch}`, tok);
  const status = head.ok && head.data.sha ? await getPrStatus(owner, repo, head.data.sha, tok) : { state: "none", checks: [] };
  const prs = await listPullRequests(owner, repo, tok);
  const openPrs = prs.ok ? prs.data.length : 0;
  return {
    repo: `${owner}/${repo}`,
    defaultBranch: branch,
    ci: status.state,
    pushedAt: meta.data.pushed_at || "",
    // open_issues_count counts PRs too; subtract them so this reads as real issues.
    openIssues: Math.max(0, (meta.data.open_issues_count || 0) - openPrs),
    openPrs,
    failingChecks: status.checks.filter((c) => c.conclusion !== "success" && c.conclusion !== "neutral" && c.conclusion !== "skipped").map((c) => c.name),
  };
}

// Health across every configured repo, freshest activity first.
export async function listReposHealth(token?: string): Promise<RepoHealth[]> {
  const tok = token ?? (await getToken());
  const repos = await listConfiguredRepos();
  const out: RepoHealth[] = [];
  for (const { owner, repo } of repos) out.push(await getRepoHealth(owner, repo, tok));
  out.sort((a, b) => (b.pushedAt || "").localeCompare(a.pushedAt || ""));
  return out;
}

// ── summarize / review a PR via the rotating router ──────────────────────────
const PATCH_BUDGET = 12_000; // total chars of diff fed to the model (token guard)

export async function summarizePr(
  owner: string, repo: string, number: number, mode: "summary" | "review", token?: string
): Promise<GhResult<{ text: string; title: string }>> {
  if (!isValidRepo(owner, repo) || !Number.isInteger(number)) return { ok: false, status: 400, error: "Invalid PR reference." };
  const tok = token ?? (await getToken());
  const pr = await gh<any>(`/repos/${owner}/${repo}/pulls/${number}`, tok);
  if (!pr.ok) return pr;
  const files = await gh<any[]>(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, tok);
  const fileList = files.ok ? files.data : [];

  let budget = PATCH_BUDGET;
  const diffParts: string[] = [];
  for (const f of fileList) {
    const header = `\n--- ${f.filename} (+${f.additions}/-${f.deletions}) ---\n`;
    const patch = typeof f.patch === "string" ? f.patch : "(no textual diff — binary or too large)";
    const chunk = header + patch;
    if (budget - chunk.length < 0) { diffParts.push(`${header}(diff truncated to stay within budget)`); break; }
    budget -= chunk.length;
    diffParts.push(chunk);
  }

  const wanted =
    mode === "review"
      ? "Act as a senior code reviewer. Review this pull request: flag correctness bugs, security issues, missing tests, and risky changes, with file references. Be concise and concrete. End with a one-line verdict (LGTM / needs work)."
      : "Summarize this pull request for a teammate: what it changes, why, and any notable risks. Be concise (a short paragraph + bullet points).";

  const userContent = [
    `Repository: ${owner}/${repo}`,
    `PR #${number}: ${pr.data.title}`,
    pr.data.body ? `Description:\n${String(pr.data.body).slice(0, 2000)}` : "",
    `Changed files: ${fileList.length}`,
    `Diff:\n${diffParts.join("\n") || "(no diff available)"}`,
  ].filter(Boolean).join("\n\n");

  const result = await routeChatCompletion({
    model: "auto",
    messages: [
      { role: "system", content: wanted },
      { role: "user", content: userContent },
    ],
    temperature: 0.3,
    max_tokens: 900,
  });
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  const json = await result.response.json().catch(() => ({} as any));
  const text = json?.choices?.[0]?.message?.content?.trim() || "(the model returned no text)";
  return { ok: true, data: { text, title: pr.data.title } };
}

// ── summarize a whole repo + changes since the last summary ───────────────────
// The "last seen" head SHA + the previous summary are persisted in mail_kv
// (ns "github", key "summary:owner/repo"). On the first call we summarize the
// repo overall (description + README + recent commits); on later calls we diff
// the default-branch head against the stored SHA and summarize ONLY what changed.
// When nothing has changed we return the stored summary without spending tokens.
const REPO_SUMMARY_BUDGET = 14_000; // chars of diff/README fed to the model

export type RepoSummary = { sha: string; at: string; text: string; mode: "overview" | "changes" };

export async function getRepoSummaryState(owner: string, repo: string): Promise<RepoSummary | null> {
  if (!isValidRepo(owner, repo)) return null;
  return kvGet<RepoSummary>(`summary:${owner}/${repo}`);
}

export async function summarizeRepo(
  owner: string, repo: string, token?: string
): Promise<GhResult<{ text: string; mode: "overview" | "changes"; sha: string; at: string; unchanged: boolean }>> {
  if (!isValidRepo(owner, repo)) return { ok: false, status: 400, error: "Invalid owner/repo." };
  const tok = token ?? (await getToken());
  const meta = await gh<{ default_branch?: string; description?: string; language?: string }>(`/repos/${owner}/${repo}`, tok);
  if (!meta.ok) return meta;
  const branch = meta.data.default_branch || "main";
  const head = await gh<{ sha?: string }>(`/repos/${owner}/${repo}/commits/${branch}`, tok);
  if (!head.ok) return head;
  const headSha = head.data.sha || "";
  const prev = await getRepoSummaryState(owner, repo);

  // Nothing new since the last press → return the stored summary, no model call.
  if (prev && prev.sha && prev.sha === headSha) {
    return { ok: true, data: { text: prev.text, mode: prev.mode, sha: headSha, at: prev.at, unchanged: true } };
  }

  let system: string;
  let userContent: string;
  let mode: "overview" | "changes";

  if (prev?.sha) {
    // Diff the stored SHA against the new head → summarize the changes.
    mode = "changes";
    const cmp = await gh<any>(`/repos/${owner}/${repo}/compare/${prev.sha}...${headSha}`, tok);
    if (!cmp.ok) return cmp;
    const commits: string = (cmp.data.commits || [])
      .map((c: any) => `- ${String(c.sha || "").slice(0, 7)} ${String(c.commit?.message || "").split("\n")[0]} (${c.commit?.author?.name || "?"})`)
      .join("\n");
    let budget = REPO_SUMMARY_BUDGET;
    const diffParts: string[] = [];
    for (const f of cmp.data.files || []) {
      const header = `\n--- ${f.filename} (+${f.additions}/-${f.deletions}) ---\n`;
      const patch = typeof f.patch === "string" ? f.patch : "(no textual diff — binary or too large)";
      const chunk = header + patch;
      if (budget - chunk.length < 0) { diffParts.push(`${header}(diff truncated to stay within budget)`); break; }
      budget -= chunk.length;
      diffParts.push(chunk);
    }
    system = "Summarize what changed in this repository since the last check, for the repo owner. Group related changes, call out notable features, fixes, and risks, with file references. Be concise: a short paragraph followed by bullet points.";
    userContent = [
      `Repository: ${owner}/${repo} (branch ${branch})`,
      `Commits since last check (${(cmp.data.commits || []).length}):\n${commits || "(none)"}`,
      `File changes:\n${diffParts.join("\n") || "(none)"}`,
    ].join("\n\n");
  } else {
    // First time → overall content overview.
    mode = "overview";
    const readme = await gh<{ content?: string; encoding?: string }>(`/repos/${owner}/${repo}/readme`, tok);
    let readmeText = "";
    if (readme.ok && readme.data.content) {
      try {
        readmeText = Buffer.from(readme.data.content, (readme.data.encoding as BufferEncoding) || "base64")
          .toString("utf8").slice(0, 8000);
      } catch { /* ignore decode errors */ }
    }
    const recentR = await gh<any[]>(`/repos/${owner}/${repo}/commits?sha=${branch}&per_page=15`, tok);
    const recent = recentR.ok ? recentR.data.map((c: any) => `- ${String(c.commit?.message || "").split("\n")[0]}`).join("\n") : "";
    system = "Summarize what this repository is and its current state, for the owner. Cover its purpose, main components, and recent direction. Be concise: a short paragraph followed by bullet points.";
    userContent = [
      `Repository: ${owner}/${repo} (branch ${branch})`,
      meta.data.description ? `Description: ${meta.data.description}` : "",
      meta.data.language ? `Primary language: ${meta.data.language}` : "",
      readmeText ? `README:\n${readmeText}` : "(no README)",
      recent ? `Recent commits:\n${recent}` : "",
    ].filter(Boolean).join("\n\n");
  }

  const result = await routeChatCompletion({
    model: "auto",
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
    temperature: 0.3,
    max_tokens: 900,
  });
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  const json = await result.response.json().catch(() => ({} as any));
  const text = json?.choices?.[0]?.message?.content?.trim() || "(the model returned no text)";
  const at = new Date().toISOString();
  await kvSet(`summary:${owner}/${repo}`, { sha: headSha, at, text, mode } satisfies RepoSummary);
  return { ok: true, data: { text, mode, sha: headSha, at, unchanged: false } };
}
