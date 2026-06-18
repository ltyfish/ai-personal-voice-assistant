// One-off: add a `position` column (manual drag-order) to tasks, subtasks,
// notes, and projects. Lower = higher in the list; overrides priority-sort once
// the user reorders. Existing rows are seeded so their CURRENT visual order is
// preserved (by created_at / updated_at), spaced by 1000 to leave gaps.
// Idempotent. Run: node scripts/add-position-cols.mjs
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

await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 1000000`;
await sql`ALTER TABLE subtasks ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 1000000`;
await sql`ALTER TABLE notes ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 1000000`;
await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 1000000`;

// Seed positions from current visual order so nothing visibly jumps on first load.
// tasks: API sorted by due_date; keep that, nulls last, then created_at.
await sql`
  WITH ordered AS (
    SELECT id, row_number() OVER (
      ORDER BY due_date ASC NULLS LAST, created_at DESC
    ) * 1000 AS pos FROM tasks WHERE position = 1000000
  )
  UPDATE tasks SET position = ordered.pos FROM ordered WHERE tasks.id = ordered.id`;

await sql`
  WITH ordered AS (
    SELECT id, row_number() OVER (
      PARTITION BY task_id ORDER BY created_at ASC
    ) * 1000 AS pos FROM subtasks WHERE position = 1000000
  )
  UPDATE subtasks SET position = ordered.pos FROM ordered WHERE subtasks.id = ordered.id`;

await sql`
  WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY updated_at DESC) * 1000 AS pos
    FROM notes WHERE position = 1000000
  )
  UPDATE notes SET position = ordered.pos FROM ordered WHERE notes.id = ordered.id`;

await sql`
  WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY seq ASC) * 1000 AS pos
    FROM projects WHERE position = 1000000
  )
  UPDATE projects SET position = ordered.pos FROM ordered WHERE projects.id = ordered.id`;

console.log("position columns added + seeded for tasks/subtasks/notes/projects.");
