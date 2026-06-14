// One-off: create the MailMind tables (mail_kv, mail_summaries) directly,
// without drizzle-kit push touching the existing tasks/events/notes tables.
// Run: node scripts/create-mail-tables.mjs
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
  CREATE TABLE IF NOT EXISTS mail_kv (
    namespace text NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mail_kv_namespace_key_pk PRIMARY KEY (namespace, key)
  )
`;

await sql`
  CREATE TABLE IF NOT EXISTS mail_summaries (
    date text NOT NULL,
    email_id text NOT NULL,
    data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mail_summaries_date_email_id_pk PRIMARY KEY (date, email_id)
  )
`;

const rows = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN ('mail_kv','mail_summaries')
  ORDER BY table_name
`;
console.log("Tables present:", rows.map((r) => r.table_name).join(", "));
console.log("Done.");
