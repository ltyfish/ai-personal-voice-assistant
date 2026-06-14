// Server-side page reader for the voice agent's "read it out / summarize" ability.
//
// Jarvis can fetch a PUBLIC website, strip it to readable text, and hand that to
// the LLM to summarize or read back. The extracted text is CACHED in mail_kv
// (namespace "pagecache", keyed by URL) with a short TTL, so re-asking about the
// same page ("summarize deployment" twice) costs no second fetch and the model
// works from the same compact text — the token-saving idea behind this feature.
//
// LIMITS (by design, Phase 1): this is a plain server fetch — it sees only what
// an anonymous request sees. Pages behind a login or rendered entirely by
// client-side JS (most dashboards) won't yield useful text here; those go through
// the local bridge (Phase 2), which drives a real browser with your sessions.

import { and, eq } from "drizzle-orm";
import { db, mailKv } from "@/db";

const NS = "pagecache";
const TTL_MS = 30 * 60 * 1000; // 30 min — pages don't change second-to-second
const MAX_BYTES = 2_000_000; // stop reading a response after ~2 MB
const MAX_TEXT = 12_000; // cap extracted text fed to the model (~3-4k tokens)
const FETCH_TIMEOUT_MS = 12_000;

export type PageContent = {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  fromCache: boolean;
  fetchedAt: number;
};

type CachedPage = { title: string; text: string; truncated: boolean; at: number };

// ── HTML → readable text ────────────────────────────────────────────────────
// Deliberately dependency-free: drop the noisy/structural elements, unwrap the
// rest to whitespace, decode the handful of entities that actually matter, and
// collapse runs of blank space. Not a full DOM parse — just enough to give the
// model clean prose without scripts, styles, or nav chrome.
function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ""; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; }
    });
}

function htmlToText(html: string): string {
  let s = html;
  // Strip whole noisy blocks (with their content).
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<(nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  // Turn block-level tags into line breaks so paragraphs/list items stay separate.
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Drop every remaining tag.
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  // Collapse whitespace; keep paragraph breaks.
  s = s.replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").replace(/^\s+|\s+$/gm, "");
  return s.trim();
}

// ── Cache (mail_kv) ─────────────────────────────────────────────────────────
async function readCache(url: string): Promise<CachedPage | null> {
  const rows = await db
    .select({ value: mailKv.value })
    .from(mailKv)
    .where(and(eq(mailKv.namespace, NS), eq(mailKv.key, url)));
  const v = rows.length ? (rows[0].value as CachedPage) : null;
  if (!v || typeof v.text !== "string" || typeof v.at !== "number") return null;
  if (Date.now() - v.at > TTL_MS) return null;
  return v;
}

async function writeCache(url: string, page: CachedPage): Promise<void> {
  await db
    .insert(mailKv)
    .values({ namespace: NS, key: url, value: page as object })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value: page as object, updatedAt: new Date() },
    });
}

// ── Public API ──────────────────────────────────────────────────────────────
// Fetch (cache-first) and return clean text. Throws a friendly Error the agent
// can read back when the page can't be retrieved/read.
export async function readPage(
  url: string,
  opts?: { refresh?: boolean }
): Promise<PageContent> {
  if (!/^https?:\/\//i.test(url)) throw new Error("That isn't a web address I can read.");

  if (!opts?.refresh) {
    const cached = await readCache(url);
    if (cached) {
      return { url, title: cached.title, text: cached.text, truncated: cached.truncated, fromCache: true, fetchedAt: cached.at };
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        // A real browser UA + Accept so sites return HTML, not a bot wall.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === "AbortError") throw new Error("That page took too long to load.");
    throw new Error("I couldn't reach that page.");
  }
  clearTimeout(timer);

  if (!res.ok) throw new Error(`That page returned an error (${res.status}).`);
  const ctype = res.headers.get("content-type") || "";
  if (!/text\/html|text\/plain|application\/xhtml/i.test(ctype) && ctype) {
    throw new Error("That link isn't a readable web page.");
  }

  // Read the body with a hard byte cap so a huge page can't blow up memory.
  const reader = res.body?.getReader();
  let html = "";
  if (reader) {
    const decoder = new TextDecoder();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (total >= MAX_BYTES) { try { await reader.cancel(); } catch {} break; }
    }
  } else {
    html = await res.text();
  }

  const title = extractTitle(html) || new URL(url).hostname;
  let text = htmlToText(html);
  const truncated = text.length > MAX_TEXT;
  if (truncated) text = text.slice(0, MAX_TEXT);
  if (!text) throw new Error("I couldn't find readable text on that page.");

  const at = Date.now();
  // Caching is best-effort — never fail a read because the cache write didn't.
  try { await writeCache(url, { title, text, truncated, at }); } catch {}

  return { url, title, text, truncated, fromCache: false, fetchedAt: at };
}

// ── Web search (results WITH text, not just a tab) ──────────────────────────
// The agent's "search X and tell me about it" ability. Unlike search_web (which
// only builds a Google URL to OPEN), this actually runs the search server-side
// and returns the top results as { title, url, snippet } so the model can answer
// from them — or follow up with readPage(url) on a promising result for detail.
// Uses DuckDuckGo's no-key HTML endpoint and the same dependency-free parsing.
export type SearchResult = { title: string; url: string; snippet: string };

function cleanFrag(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

// DDG result links are redirects like `//duckduckgo.com/l/?uddg=<encoded url>`;
// pull the real destination out of the uddg param.
function decodeDdgUrl(href: string): string {
  let u = href;
  if (u.startsWith("//")) u = "https:" + u;
  try {
    const parsed = new URL(u);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return uddg;
  } catch {
    /* fall through */
  }
  return /^https?:/i.test(u) ? u : "";
}

function parseDdg(html: string, limit: number): SearchResult[] {
  // Snippets and links each appear once per result, in document order — collect
  // both lists and pair by index.
  const snippets: string[] = [];
  const snipRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  for (let sm; (sm = snipRe.exec(html)); ) snippets.push(cleanFrag(sm[1]));

  const out: SearchResult[] = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let i = 0;
  for (let m; (m = linkRe.exec(html)) && out.length < limit; i++) {
    const url = decodeDdgUrl(m[1]);
    const title = cleanFrag(m[2]);
    if (url && title) out.push({ title, url, snippet: snippets[i] || "" });
  }
  return out;
}

export async function searchWeb(query: string, limit = 6): Promise<SearchResult[]> {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === "AbortError") throw new Error("That search took too long.");
    throw new Error("I couldn't reach the search service.");
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(`Search returned an error (${res.status}).`);
  return parseDdg(await res.text(), limit);
}
