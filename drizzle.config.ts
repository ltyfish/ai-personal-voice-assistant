import type { Config } from "drizzle-kit";
import { config } from "dotenv";

// drizzle-kit (unlike Next.js) does not auto-load .env.local
config({ path: ".env.local" });

export default {
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config;
