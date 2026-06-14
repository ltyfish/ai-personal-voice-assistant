// One-off: create the `llm_models` catalog table used by the native router's
// auto chain. Safe to re-run.
//   node scripts/create-llm-models-table.mjs
import "dotenv/config";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { neon } from "@neondatabase/serverless";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  try {
    const env = readFileSync(path.resolve(__dirname, "..", ".env.local"), "utf8");
    const m = env.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m);
    if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "");
  } catch {}
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not found (.env.local).");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

await sql`
  CREATE TABLE IF NOT EXISTS llm_models (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform text NOT NULL,
    model text NOT NULL,
    display_name text NOT NULL DEFAULT '',
    enabled boolean NOT NULL DEFAULT true,
    context_window integer,
    tpd_limit integer,
    rpd_limit integer,
    rpm_limit integer,
    source text NOT NULL DEFAULT 'manual',
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT llm_models_platform_model UNIQUE (platform, model)
  )`;

console.log("llm_models table ready.");
