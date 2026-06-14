// One-off migration: add `seq` (serial) to tasks/events/notes and `done` to
// events, WITHOUT data loss. Postgres backfills existing rows for a new serial.
import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

const stmts = [
  `ALTER TABLE tasks  ADD COLUMN IF NOT EXISTS seq serial`,
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS seq serial`,
  `ALTER TABLE notes  ADD COLUMN IF NOT EXISTS seq serial`,
  `ALTER TABLE events ADD COLUMN IF NOT EXISTS done boolean NOT NULL DEFAULT false`,
];

for (const s of stmts) {
  await sql(s);
  console.log("ok:", s);
}
console.log("done");
