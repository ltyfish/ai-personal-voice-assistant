// One-off, idempotent, NON-destructive migration: adds the `subtasks` table and
// the `notes.date` column. Avoids `drizzle-kit push` (which tries to reconcile the
// whole schema and currently trips on unrelated llm_usage / PK drift).
//
// Run:  node scripts/db-add-subtasks-notes-date.mjs
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

// Pull DATABASE_URL from .env.local if it isn't already in the environment.
if (!process.env.DATABASE_URL) {
  try {
    const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*(.*)$/);
      if (m) {
        process.env.DATABASE_URL = m[1].trim().replace(/^["']|["']$/g, "");
        break;
      }
    }
  } catch {
    /* fall through to the error below */
  }
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not found (env or .env.local).");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

const run = async () => {
  // `priority` enum + gen_random_uuid() already exist (used by the tasks table).
  await sql`
    CREATE TABLE IF NOT EXISTS subtasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title text NOT NULL,
      done boolean NOT NULL DEFAULT false,
      priority priority NOT NULL DEFAULT 'medium',
      due_date timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE notes ADD COLUMN IF NOT EXISTS "date" timestamptz`;
  await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS improvement_times jsonb NOT NULL DEFAULT '{}'::jsonb`;
  console.log("✓ subtasks table + notes.date + projects.improvement_times ensured.");
};

run().catch((e) => {
  console.error("Migration failed:", e.message || e);
  process.exit(1);
});
