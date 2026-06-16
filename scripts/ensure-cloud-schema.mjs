// Idempotent schema guard for the CLOUD deploy. Local dev tends to accrue
// columns/tables as the app evolves, but the cloud Neon DB only has whatever a
// migration actually ran against it — so a feature that works locally (e.g.
// Projects > improvements, or the email digest) silently 500s on cloud when its
// table/column is missing. This script CREATEs/ALTERs everything additively with
// IF NOT EXISTS, so it's safe to run repeatedly against either DB.
//
// Run against whatever DATABASE_URL points at:
//   node scripts/ensure-cloud-schema.mjs
// To fix the cloud DB specifically, run it with the cloud DATABASE_URL exported.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
const sql = neon(process.env.DATABASE_URL);

// 1) Router live-rotation feed (makes the LIVE ROTATION panel work on cloud).
await sql`
  CREATE TABLE IF NOT EXISTS router_events (
    id serial PRIMARY KEY,
    at bigint NOT NULL,
    kind text NOT NULL,
    model text NOT NULL,
    api_key text,
    status integer,
    prompt integer,
    completion integer,
    total integer,
    detail text
  )
`;
await sql`CREATE INDEX IF NOT EXISTS router_events_id_idx ON router_events (id)`;

// 2) Generic KV + mail summaries (back memory, behavior, mail config/state/digest).
await sql`
  CREATE TABLE IF NOT EXISTS mail_kv (
    namespace text NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (namespace, key)
  )
`;
await sql`
  CREATE TABLE IF NOT EXISTS mail_summaries (
    date text NOT NULL,
    email_id text NOT NULL,
    data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (date, email_id)
  )
`;

// 3) Projects: the improvement columns are the usual cloud breakage. Without
//    improvement_times every SELECT * on projects 500s, so the whole Projects
//    tab (and "create improvements") fails on cloud while working locally.
await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS improvements jsonb NOT NULL DEFAULT '[]'::jsonb`;
await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS improvement_times jsonb NOT NULL DEFAULT '{}'::jsonb`;

const tables = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('router_events','mail_kv','mail_summaries','projects')
  ORDER BY table_name
`;
const cols = await sql`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'projects'
    AND column_name IN ('improvements','improvement_times')
  ORDER BY column_name
`;
console.log("Tables present:", tables.map((t) => t.table_name).join(", "));
console.log("Projects improvement columns:", cols.map((c) => c.column_name).join(", "));
console.log("Done.");
