import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  serial,
  pgEnum,
  jsonb,
  primaryKey,
  integer,
  bigint,
  unique,
} from "drizzle-orm/pg-core";

export const priorityEnum = pgEnum("priority", ["low", "medium", "high"]);
export const recurrenceEnum = pgEnum("recurrence", [
  "none",
  "daily",
  "weekly",
  "monthly",
]);

// ---- Tasks ----
export const tasks = pgTable("tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  seq: serial("seq").notNull(), // short human ref: t{seq}
  title: text("title").notNull(),
  notes: text("notes"),
  done: boolean("done").notNull().default(false),
  priority: priorityEnum("priority").notNull().default("medium"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---- Subtasks ----
// A checklist item under a task (Google-Tasks style). Same core fields as a task
// so each can carry its own due date + priority. Cascade-deleted with the parent.
export const subtasks = pgTable("subtasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  done: boolean("done").notNull().default(false),
  priority: priorityEnum("priority").notNull().default("medium"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export type Subtask = typeof subtasks.$inferSelect;

// ---- Projects ----
// A project is a card the user collects "improvements" (notes) on over time, and
// can optionally schedule time for (see events.projectId, which surfaces a
// "project event" on the calendar). `improvements` is a plain string array so the
// UI and the voice agent can add / edit / delete individual entries.
export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  seq: serial("seq").notNull(), // short human ref: p{seq}
  title: text("title").notNull(),
  improvements: jsonb("improvements").$type<string[]>().notNull().default([]),
  // Optional scheduled time per improvement, keyed by the improvement's text →
  // ISO string. Separate from `improvements` so the voice agent (which treats
  // improvements as a plain string[]) is unaffected. UI-managed only.
  improvementTimes: jsonb("improvement_times")
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  done: boolean("done").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---- Calendar events ----
export const events = pgTable("events", {
  id: uuid("id").defaultRandom().primaryKey(),
  seq: serial("seq").notNull(), // short human ref: e{seq}
  title: text("title").notNull(),
  location: text("location"),
  done: boolean("done").notNull().default(false),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  recurrence: recurrenceEnum("recurrence").notNull().default("none"),
  recurrenceEnd: timestamp("recurrence_end", { withTimezone: true }),
  // When set, this event is time scheduled for a project — rendered with a
  // distinct icon on the calendar ("project event").
  projectId: uuid("project_id").references(() => projects.id, {
    onDelete: "cascade",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---- Notes ----
export const notes = pgTable("notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  seq: serial("seq").notNull(), // short human ref: n{seq}
  title: text("title"),
  body: text("body").notNull(),
  // Optional date the note is "about" — when set, the note shows on the calendar.
  date: timestamp("date", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---- Mail (email-summarizer) ----
// Generic key/value store replacing Netlify Blobs `settings` + `state` stores.
// Rows: ("settings","config"), ("state","poll-state"), ("state","groq-stats").
export const mailKv = pgTable(
  "mail_kv",
  {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.namespace, t.key] }) })
);

// Replaces the Netlify Blobs `summaries` store, which was keyed by `${date}/${id}`.
export const mailSummaries = pgTable(
  "mail_summaries",
  {
    date: text("date").notNull(), // UTC YYYY-MM-DD bucket (from receivedAt)
    emailId: text("email_id").notNull(),
    data: jsonb("data").notNull(), // full summary object
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.date, t.emailId] }) })
);

export type Task = typeof tasks.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Project = typeof projects.$inferSelect;

// ---- LLM rotation keys ----
// Pool of free-tier provider API keys the built-in /v1 rotation proxy cycles
// through. Multiple rows per platform are expected (e.g. 6 groq keys) so the
// router can rotate within a provider to multiply free quota. `cooldownUntil`
// is set when a key 429s / errors so the round-robin skips it temporarily —
// this replaces FreeLLMAPI's background health-checker (no background loop on
// serverless). Keys live server-side only; the API never returns them unmasked.
export const llmKeys = pgTable("llm_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  platform: text("platform").notNull(),
  label: text("label").notNull().default(""),
  apiKey: text("api_key").notNull(),
  baseUrl: text("base_url"), // only for platform 'custom'
  enabled: boolean("enabled").notNull().default(true),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  failCount: integer("fail_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type LlmKey = typeof llmKeys.$inferSelect;

// ---- LLM model catalog ----
// Native catalog of provider/model ids the auto router may use. Populated from
// the bridge/freellmapi catalog when available, and supplemented by the small
// built-in fallback chain in lib/llm-router.ts when empty.
export const llmModels = pgTable(
  "llm_models",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    platform: text("platform").notNull(),
    model: text("model").notNull(),
    displayName: text("display_name").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    contextWindow: integer("context_window"),
    tpdLimit: integer("tpd_limit"),
    rpdLimit: integer("rpd_limit"),
    rpmLimit: integer("rpm_limit"),
    source: text("source").notNull().default("manual"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ platformModel: unique("llm_models_platform_model").on(t.platform, t.model) }),
);

export type LlmModel = typeof llmModels.$inferSelect;

// ---- LLM token usage ----
// Per (key, model) running token tally, written by the /v1 rotation proxy after
// each successful upstream response. The Pipeline dashboard aggregates these by
// model and by provider/key. `todayTokens` resets when `todayDate` (YYYY-MM-DD,
// UTC) rolls over, so the board can show "today vs all-time" without a cron.
// `bigint(mode:number)` keeps JS numbers (token totals stay well under 2^53).
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    keyId: uuid("key_id").notNull(),
    platform: text("platform").notNull(),
    model: text("model").notNull(),
    promptTokens: bigint("prompt_tokens", { mode: "number" }).notNull().default(0),
    completionTokens: bigint("completion_tokens", { mode: "number" }).notNull().default(0),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
    requests: integer("requests").notNull().default(0),
    todayTokens: bigint("today_tokens", { mode: "number" }).notNull().default(0),
    todayDate: text("today_date").notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ keyModel: unique("llm_usage_key_model").on(t.keyId, t.model) }),
);

export type LlmUsage = typeof llmUsage.$inferSelect;
