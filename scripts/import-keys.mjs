// One-off: load scripts/migrated-keys.json (exported + decrypted from
// FreeLLMAPI) into the Neon `llm_keys` table. Run after `npm run db:push`:
//   node scripts/import-keys.mjs
// Idempotent-ish: skips a (platform, api_key) pair that already exists.
import "dotenv/config";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { neon } from "@neondatabase/serverless";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dotenv/config loads .env; this project keeps secrets in .env.local.
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
const keys = JSON.parse(readFileSync(path.resolve(__dirname, "migrated-keys.json"), "utf8"));

let inserted = 0;
let skipped = 0;
for (const k of keys) {
  const existing = await sql`
    SELECT id FROM llm_keys WHERE platform = ${k.platform} AND api_key = ${k.key} LIMIT 1`;
  if (existing.length > 0) {
    skipped++;
    continue;
  }
  await sql`
    INSERT INTO llm_keys (platform, label, api_key, base_url, enabled)
    VALUES (${k.platform}, ${k.label ?? ""}, ${k.key}, ${k.baseUrl ?? null}, ${k.enabled ?? true})`;
  inserted++;
}

console.log(`Imported ${inserted} keys, skipped ${skipped} existing. Total in file: ${keys.length}`);
