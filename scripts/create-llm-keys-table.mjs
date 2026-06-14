// Create ONLY the llm_keys table, additively — sidesteps `drizzle-kit push`,
// which diffs the whole schema and currently fails on unrelated mail_summaries
// primary-key drift (42P16). Matches db/schema.ts exactly. Safe to re-run.
//   node scripts/create-llm-keys-table.mjs
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
  CREATE TABLE IF NOT EXISTS llm_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform text NOT NULL,
    label text NOT NULL DEFAULT '',
    api_key text NOT NULL,
    base_url text,
    enabled boolean NOT NULL DEFAULT true,
    cooldown_until timestamptz,
    last_used_at timestamptz,
    fail_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;

console.log("llm_keys table ready.");
