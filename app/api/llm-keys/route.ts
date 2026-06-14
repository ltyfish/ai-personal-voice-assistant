import { NextRequest, NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db, llmKeys } from "@/db";
import { PROVIDERS, listPlatforms } from "@/lib/llm-router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mask(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "****" + key.slice(-2);
  return key.slice(0, 4) + "…" + key.slice(-4);
}

// GET — list keys (masked, never the raw value) + cooldown status, grouped-ready.
export async function GET() {
  const rows = await db.select().from(llmKeys).orderBy(asc(llmKeys.platform), asc(llmKeys.createdAt));
  const now = Date.now();
  return NextResponse.json({
    platforms: listPlatforms(),
    keys: rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      label: r.label,
      maskedKey: mask(r.apiKey),
      baseUrl: r.baseUrl,
      enabled: r.enabled,
      failCount: r.failCount,
      cooledDown: r.cooldownUntil ? r.cooldownUntil.getTime() > now : false,
      cooldownUntil: r.cooldownUntil,
      lastUsedAt: r.lastUsedAt,
    })),
  });
}

// POST — add a single key { platform, key, label?, baseUrl? }, or bulk import
// { import: [{ platform, key, label?, baseUrl?, enabled? }, ...] }.
export async function POST(req: NextRequest) {
  let b: any;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rows: { platform: string; key: string; label?: string; baseUrl?: string | null; enabled?: boolean }[] =
    Array.isArray(b?.import) ? b.import : [{ platform: b?.platform, key: b?.key, label: b?.label, baseUrl: b?.baseUrl }];

  const valid = rows.filter((r) => r && PROVIDERS[r.platform] && (r.key || PROVIDERS[r.platform].keyless));
  if (valid.length === 0) {
    return NextResponse.json(
      { error: `Need { platform, key } with a known platform (${listPlatforms().join(", ")})` },
      { status: 400 },
    );
  }

  const inserted = await db
    .insert(llmKeys)
    .values(
      valid.map((r) => ({
        platform: r.platform,
        label: r.label ?? "",
        apiKey: r.key ?? "",
        baseUrl: r.baseUrl ?? null,
        enabled: r.enabled ?? true,
      })),
    )
    .returning({ id: llmKeys.id });

  return NextResponse.json({ inserted: inserted.length });
}
