import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.local.example to .env.local.");
}

// `cache: "no-store"` is critical on Vercel: the Neon HTTP driver issues queries
// via fetch(), and Next.js's Data Cache will otherwise persist a query result
// ACROSS deployments — which silently served a stale relay presence row frozen at
// one moment in time no matter how many times we redeployed. Forcing no-store
// guarantees every DB read hits the live database.
const sql = neon(process.env.DATABASE_URL, {
  fetchOptions: { cache: "no-store" },
});
export const db = drizzle(sql, { schema });
export * from "./schema";
