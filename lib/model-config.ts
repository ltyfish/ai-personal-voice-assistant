// User's model selection (which fallback models are enabled), stored in mail_kv
// (namespace "models", key "config") — same pattern as contacts/keywords. Empty
// `disabled` means every model in the registry is in play.

import { and, eq } from "drizzle-orm";
import { db, mailKv } from "@/db";
import { MODEL_IDS } from "./models";

const NS = "models";
const KEY = "config";

export type ModelConfig = { disabled: string[] };

export async function getModelConfig(): Promise<ModelConfig> {
  const rows = await db
    .select({ value: mailKv.value })
    .from(mailKv)
    .where(and(eq(mailKv.namespace, NS), eq(mailKv.key, KEY)));
  const v = rows.length ? (rows[0].value as { disabled?: string[] }) : null;
  const disabled = Array.isArray(v?.disabled)
    ? v!.disabled.filter((id) => MODEL_IDS.includes(id))
    : [];
  return { disabled };
}

export async function saveModelConfig(input: { disabled?: string[] }): Promise<ModelConfig> {
  const disabled = Array.isArray(input?.disabled)
    ? [...new Set(input.disabled.filter((id) => MODEL_IDS.includes(id)))]
    : [];
  await db
    .insert(mailKv)
    .values({ namespace: NS, key: KEY, value: { disabled } as object })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value: { disabled } as object, updatedAt: new Date() },
    });
  return { disabled };
}
