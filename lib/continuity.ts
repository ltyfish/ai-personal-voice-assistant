// Cloud-side short-term conversation memory. The LOCAL path remembers recent turns
// via activity.md in the vault (lib/ollama-context.ts), but the cloud loop runs on
// Vercel with no disk, so it had NO continuity across turns. We mirror the same idea
// into the DB (mail_kv, like lib/behavior.ts + lib/memory.ts): append each cloud
// turn, then inject the last few as a VOLATILE block at the END of the prompt (after
// the cacheable static prefix + tools) so the model knows what was just said without
// breaking the provider prompt cache.

import { and, eq } from "drizzle-orm";
import { db, mailKv } from "@/db";

const NS = "cloud_convo";
const KEY = "recent";
const MAX_TURNS = 6; // rolling window kept in the DB and injected

type Turn = { u: string; a: string };

function readTurns(value: unknown): Turn[] {
  const turns = (value as { turns?: Turn[] } | undefined)?.turns;
  return Array.isArray(turns) ? turns : [];
}

// The last `n` cloud turns as a compact prompt block, oldest→newest, or "" if none.
export async function getRecentTurns(n = MAX_TURNS): Promise<string> {
  try {
    const rows = await db
      .select({ value: mailKv.value })
      .from(mailKv)
      .where(and(eq(mailKv.namespace, NS), eq(mailKv.key, KEY)))
      .limit(1);
    const recent = readTurns(rows[0]?.value).slice(-n);
    if (!recent.length) return "";
    const lines = recent.map((t) => `- User: "${t.u}" → You: "${t.a}"`).join("\n");
    return `## Recent conversation (your last ${recent.length} turns)\n${lines}`;
  } catch {
    return "";
  }
}

// Append one turn to the rolling window. Best-effort: a DB failure never breaks a
// turn (the reply is already produced by the time this runs).
export async function appendTurn(user: string, reply: string): Promise<void> {
  const u = String(user ?? "").trim();
  const a = String(reply ?? "").trim();
  if (!u || !a) return;
  try {
    const rows = await db
      .select({ value: mailKv.value })
      .from(mailKv)
      .where(and(eq(mailKv.namespace, NS), eq(mailKv.key, KEY)))
      .limit(1);
    const turns = readTurns(rows[0]?.value);
    turns.push({ u, a });
    const trimmed = turns.slice(-MAX_TURNS);
    await db
      .insert(mailKv)
      .values({ namespace: NS, key: KEY, value: { turns: trimmed } })
      .onConflictDoUpdate({
        target: [mailKv.namespace, mailKv.key],
        set: { value: { turns: trimmed }, updatedAt: new Date() },
      });
  } catch {
    /* best-effort */
  }
}
