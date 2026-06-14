// JARVIS's behavior/persona prompt — the user-editable "how you act" rules that
// live in behavior.md in the Obsidian vault. Historically the CLOUD path used a
// hardcoded CORE_PROMPT while only the LOCAL path read behavior.md, so editing
// the file in Obsidian changed local behavior but never cloud.
//
// To unify them, the behavior TEXT is mirrored into the cloud DB (mail_kv) — the
// same trick lib/memory.ts uses so both runtimes can see it (Vercel can't read the
// local vault). The LOCAL instance (which DOES have the vault) pushes the file's
// content to the DB each turn via syncBehaviorFile() (lib/ollama-context.ts); the
// CLOUD loop reads it here via getBehavior(). So a single Obsidian edit now affects
// both paths.

import { and, eq } from "drizzle-orm";
import { db, mailKv } from "@/db";

const NS = "behavior";
const KEY = "prompt";

// The current behavior text from the DB, or "" if none is stored yet (the caller
// falls back to its built-in default). Best-effort: a DB error never breaks a turn.
export async function getBehavior(): Promise<string> {
  try {
    const rows = await db
      .select({ value: mailKv.value })
      .from(mailKv)
      .where(and(eq(mailKv.namespace, NS), eq(mailKv.key, KEY)))
      .limit(1);
    const v = rows[0]?.value as { text?: string } | undefined;
    return String(v?.text ?? "").trim();
  } catch {
    return "";
  }
}

// Push the behavior text to the DB so the cloud path reads it. Called by the local
// instance (which owns the vault file). A blank string is ignored so we never wipe
// a good stored prompt with an empty read.
export async function saveBehavior(text: string): Promise<void> {
  const t = String(text ?? "").trim();
  if (!t) return;
  await db
    .insert(mailKv)
    .values({ namespace: NS, key: KEY, value: { text: t } })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value: { text: t }, updatedAt: new Date() },
    });
}
