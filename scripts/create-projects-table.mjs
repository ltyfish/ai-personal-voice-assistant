// One-off: create the `projects` table and add events.project_id directly,
// without drizzle-kit push touching the existing tables (which have drift it
// can't reconcile non-interactively). Run: node scripts/create-projects-table.mjs
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
  CREATE TABLE IF NOT EXISTS projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq serial NOT NULL,
    title text NOT NULL,
    improvements jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`;

// Projects can be completed (moved to History) like tasks/events.
await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS done boolean NOT NULL DEFAULT false`;

// Link calendar events to a project (a "project event").
await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS project_id uuid`;

// Add the FK (drop-if-exists first so the script is idempotent).
await sql`ALTER TABLE events DROP CONSTRAINT IF EXISTS events_project_id_projects_id_fk`;
await sql`
  ALTER TABLE events
  ADD CONSTRAINT events_project_id_projects_id_fk
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
`;

const cols = await sql`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'events' AND column_name = 'project_id'
`;
const tbl = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'projects'
`;
console.log("projects table present:", tbl.length > 0);
console.log("events.project_id present:", cols.length > 0);
console.log("Done.");
