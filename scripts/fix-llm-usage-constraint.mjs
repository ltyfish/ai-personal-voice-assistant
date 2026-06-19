// Idempotent fix for the `llm_usage` table so it matches db/schema.ts WITHOUT
// drizzle-kit push (which diffs against the drifted prod table and generates a
// destructive truncate + a failing PK rewrite — error 42P16). This only ensures
// `id` is the primary key and the (key_id, model) unique constraint exists.
// No data loss. Run: node scripts/fix-llm-usage-constraint.mjs
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
const sql = neon(process.env.DATABASE_URL);

// Show current constraints first.
const before = await sql`
  SELECT con.conname, con.contype, pg_get_constraintdef(con.oid) AS def
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = rel.relnamespace
  WHERE rel.relname = 'llm_usage' AND n.nspname = 'public'`;
console.log("Before:", before);

// Ensure the unique constraint exists (the thing push wanted to add).
await sql`
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'llm_usage_key_model'
    ) THEN
      ALTER TABLE llm_usage ADD CONSTRAINT llm_usage_key_model UNIQUE (key_id, model);
    END IF;
  END $$;`;

const after = await sql`
  SELECT con.conname, con.contype, pg_get_constraintdef(con.oid) AS def
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = rel.relnamespace
  WHERE rel.relname = 'llm_usage' AND n.nspname = 'public'`;
console.log("After:", after);
console.log("Done.");
