// One-off: create the `llm_usage` table (per key+model token tallies that the
// /v1 rotation proxy writes and the Pipeline dashboard reads). Avoids drizzle-kit
// push touching the existing drifted tables. Run: node scripts/create-llm-usage-table.mjs
import "dotenv/config";
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

// dotenv/config only reads .env; load .env.local explicitly.
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {}

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");

const sql = neon(process.env.DATABASE_URL);

await sql`
  CREATE TABLE IF NOT EXISTS llm_usage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key_id uuid NOT NULL,
    platform text NOT NULL,
    model text NOT NULL,
    prompt_tokens bigint NOT NULL DEFAULT 0,
    completion_tokens bigint NOT NULL DEFAULT 0,
    total_tokens bigint NOT NULL DEFAULT 0,
    requests integer NOT NULL DEFAULT 0,
    today_tokens bigint NOT NULL DEFAULT 0,
    today_date text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT llm_usage_key_model UNIQUE (key_id, model)
  )
`;

const tbl = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'llm_usage'
`;
console.log("llm_usage table present:", tbl.length > 0);
console.log("Done.");
