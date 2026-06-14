import { NextRequest, NextResponse } from "next/server";
import { asc, sql } from "drizzle-orm";
import { db, llmModels } from "@/db";
import { PROVIDERS } from "@/lib/llm-router";
import { byBestModel } from "@/lib/model-rank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IncomingModel = {
  platform?: unknown;
  model?: unknown;
  modelId?: unknown;
  displayName?: unknown;
  enabled?: unknown;
  contextWindow?: unknown;
  tpdLimit?: unknown;
  rpdLimit?: unknown;
  rpmLimit?: unknown;
  source?: unknown;
};

function intOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function normalize(row: IncomingModel) {
  const platform = String(row.platform || "").trim();
  const model = String(row.model ?? row.modelId ?? "").trim();
  if (!platform || !model || !PROVIDERS[platform]) return null;
  return {
    platform,
    model,
    displayName: String(row.displayName || model).trim(),
    enabled: row.enabled !== false,
    contextWindow: intOrNull(row.contextWindow),
    tpdLimit: intOrNull(row.tpdLimit),
    rpdLimit: intOrNull(row.rpdLimit),
    rpmLimit: intOrNull(row.rpmLimit),
    source: String(row.source || "bridge").trim() || "bridge",
    updatedAt: new Date(),
  };
}

export async function GET() {
  const rows = await db.select().from(llmModels).orderBy(asc(llmModels.platform), asc(llmModels.model));
  return NextResponse.json({
    models: rows
      .map((m) => ({
        id: m.id,
        platform: m.platform,
        model: m.model,
        displayName: m.displayName,
        enabled: m.enabled,
        contextWindow: m.contextWindow,
        tpdLimit: m.tpdLimit,
        rpdLimit: m.rpdLimit,
        rpmLimit: m.rpmLimit,
        source: m.source,
      }))
      .sort(byBestModel((m) => `${m.platform}/${m.model}`)),
  });
}

// Bulk upsert provider model catalog:
//   { models: [{ platform, modelId/model, displayName?, enabled?, ... }] }
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = Array.isArray(body?.models) ? body.models : [];
  const rows = input.map(normalize).filter(Boolean) as NonNullable<ReturnType<typeof normalize>>[];
  if (!rows.length) {
    return NextResponse.json({ error: "Need { models: [...] } with known platform/model ids." }, { status: 400 });
  }

  await db
    .insert(llmModels)
    .values(rows)
    .onConflictDoUpdate({
      target: [llmModels.platform, llmModels.model],
      set: {
        displayName: sql`excluded.display_name`,
        // Preserve manual user disables across bridge/catalog refreshes. New
        // models use the incoming enabled value on insert; existing rows keep
        // their current enabled flag unless PATCH changes it explicitly.
        enabled: llmModels.enabled,
        contextWindow: sql`excluded.context_window`,
        tpdLimit: sql`excluded.tpd_limit`,
        rpdLimit: sql`excluded.rpd_limit`,
        rpmLimit: sql`excluded.rpm_limit`,
        source: sql`excluded.source`,
        updatedAt: new Date(),
      },
    });

  return NextResponse.json({ imported: rows.length });
}

export async function PATCH(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const platform = String(body?.platform || "").trim();
  const model = String(body?.model || "").trim();
  if (!platform || !model || typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "Need { platform, model, enabled }." }, { status: 400 });
  }
  await db
    .insert(llmModels)
    .values({
      platform,
      model,
      displayName: model,
      enabled: body.enabled,
      source: "manual",
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [llmModels.platform, llmModels.model],
      set: { enabled: body.enabled, updatedAt: new Date() },
    });
  return NextResponse.json({ ok: true });
}
