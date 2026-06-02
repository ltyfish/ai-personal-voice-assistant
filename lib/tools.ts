import { and, asc, desc, eq, gte, lte, ilike, or } from "drizzle-orm";
import { db, tasks, events, notes } from "@/db";
import { expandEvents } from "./recur";

// JSON-schema tool definitions handed to the Groq LLM.
export const toolDefs = [
  {
    type: "function" as const,
    function: {
      name: "create_task",
      description: "Create a to-do task. Use for things the user needs to DO (not timed calendar events).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          notes: { type: "string" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          due_date: { type: ["string", "null"], description: "ISO 8601 datetime with timezone offset, or null" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_task",
      description: "Update a task identified by its title (the words the user said). Use to mark done, reschedule, or change priority.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "title text to match the task by" },
          notes: { type: "string" },
          done: { type: "boolean" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          due_date: { type: ["string", "null"], description: "ISO 8601 datetime, or null to clear" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_task",
      description: "Delete a task identified by its title (the words the user said).",
      parameters: {
        type: "object",
        properties: { title: { type: "string", description: "title text to match" } },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_tasks",
      description: "List tasks. Optionally filter to only open (not done) tasks.",
      parameters: {
        type: "object",
        properties: { only_open: { type: "boolean" } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_event",
      description: "Create a timed calendar event. Supports recurrence for things like 'every Monday' (weekly), 'every day' (daily), or 'monthly'.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          location: { type: "string" },
          start_time: { type: "string", description: "ISO 8601 datetime with timezone offset (first occurrence)" },
          end_time: { type: "string", description: "ISO 8601 datetime with timezone offset" },
          recurrence: {
            type: "string",
            enum: ["none", "daily", "weekly", "monthly"],
            description: "Repeat rule. 'every Monday' => weekly with start_time on a Monday.",
          },
          recurrence_end: { type: ["string", "null"], description: "ISO 8601 date to stop repeating, or null for ongoing" },
        },
        required: ["title", "start_time", "end_time"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_event",
      description: "Update/reschedule an event identified by its title. Use to move an event to a new time/date or change its recurrence.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "title text to match the event by" },
          location: { type: "string" },
          start_time: { type: "string", description: "new ISO 8601 start" },
          end_time: { type: "string", description: "new ISO 8601 end" },
          recurrence: { type: "string", enum: ["none", "daily", "weekly", "monthly"] },
          recurrence_end: { type: ["string", "null"], description: "ISO 8601 or null" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_event",
      description: "Delete a calendar event identified by its title.",
      parameters: {
        type: "object",
        properties: { title: { type: "string", description: "title text to match" } },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_events",
      description: "List calendar events between two datetimes (inclusive). Use for 'what's today', 'what's next', 'this week'.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "ISO 8601 start of range" },
          to: { type: "string", description: "ISO 8601 end of range" },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_note",
      description: "Save a note / memo.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["body"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_notes",
      description: "Search notes by keyword. Empty query returns recent notes.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
  },
];

type Args = Record<string, any>;

// Executes a tool call and returns a JSON-serializable result fed back to the LLM.
export async function runTool(name: string, rawArgs: Args): Promise<unknown> {
  const args = rawArgs ?? {};
  try {
    return await execTool(name, args);
  } catch (err: any) {
    // Return the error to the model so it can recover (e.g. look up a real id)
    // instead of throwing a 500 that kills the whole request.
    return { error: err?.message || "tool execution failed" };
  }
}

// Resolve a task by explicit id, else fuzzy-match on title (prefer open, newest).
async function resolveTaskId(args: Args): Promise<string | null> {
  if (args.id) return args.id;
  const t = (args.title ?? "").trim();
  if (!t) return null;
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(ilike(tasks.title, `%${t}%`))
    .orderBy(asc(tasks.done), desc(tasks.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function resolveEventId(args: Args): Promise<string | null> {
  if (args.id) return args.id;
  const t = (args.title ?? "").trim();
  if (!t) return null;
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(ilike(events.title, `%${t}%`))
    .orderBy(desc(events.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function execTool(name: string, args: Args): Promise<unknown> {
  switch (name) {
    case "create_task": {
      const [row] = await db
        .insert(tasks)
        .values({
          title: args.title,
          notes: args.notes ?? null,
          priority: args.priority ?? "medium",
          dueDate: args.due_date ? new Date(args.due_date) : null,
        })
        .returning();
      return row;
    }
    case "update_task": {
      const id = await resolveTaskId(args);
      if (!id) return { error: "no matching task found" };
      const patch: Args = {};
      // title is the matcher when no explicit id, so only rename on explicit id
      if (args.id && args.title !== undefined) patch.title = args.title;
      if (args.notes !== undefined) patch.notes = args.notes;
      if (args.done !== undefined) patch.done = args.done;
      if (args.priority !== undefined) patch.priority = args.priority;
      if (args.due_date !== undefined)
        patch.dueDate = args.due_date ? new Date(args.due_date) : null;
      const [row] = await db
        .update(tasks)
        .set(patch)
        .where(eq(tasks.id, id))
        .returning();
      return row ?? { error: "task not found" };
    }
    case "delete_task": {
      const id = await resolveTaskId(args);
      if (!id) return { error: "no matching task found" };
      const [row] = await db
        .delete(tasks)
        .where(eq(tasks.id, id))
        .returning();
      return row ? { deleted: true } : { error: "task not found" };
    }
    case "list_tasks": {
      const rows = await db
        .select()
        .from(tasks)
        .where(args.only_open ? eq(tasks.done, false) : undefined)
        .orderBy(asc(tasks.dueDate));
      return rows;
    }
    case "create_event": {
      const [row] = await db
        .insert(events)
        .values({
          title: args.title,
          location: args.location ?? null,
          startTime: new Date(args.start_time),
          endTime: new Date(args.end_time),
          recurrence: args.recurrence ?? "none",
          recurrenceEnd: args.recurrence_end
            ? new Date(args.recurrence_end)
            : null,
        })
        .returning();
      return row;
    }
    case "update_event": {
      const id = await resolveEventId(args);
      if (!id) return { error: "no matching event found" };
      const patch: Args = {};
      if (args.id && args.title !== undefined) patch.title = args.title;
      if (args.location !== undefined) patch.location = args.location;
      if (args.start_time !== undefined)
        patch.startTime = new Date(args.start_time);
      if (args.end_time !== undefined) patch.endTime = new Date(args.end_time);
      if (args.recurrence !== undefined) patch.recurrence = args.recurrence;
      if (args.recurrence_end !== undefined)
        patch.recurrenceEnd = args.recurrence_end
          ? new Date(args.recurrence_end)
          : null;
      const [row] = await db
        .update(events)
        .set(patch)
        .where(eq(events.id, id))
        .returning();
      return row ?? { error: "event not found" };
    }
    case "delete_event": {
      const id = await resolveEventId(args);
      if (!id) return { error: "no matching event found" };
      const [row] = await db
        .delete(events)
        .where(eq(events.id, id))
        .returning();
      return row ? { deleted: true } : { error: "event not found" };
    }
    case "list_events": {
      const from = new Date(args.from);
      const to = new Date(args.to);
      // Fetch any event that starts on/before the window end (recurring ones
      // may have started earlier), then expand occurrences into [from, to].
      const rows = await db
        .select()
        .from(events)
        .where(lte(events.startTime, to))
        .orderBy(asc(events.startTime));
      return expandEvents(
        rows.map((r) => ({
          id: r.id,
          title: r.title,
          location: r.location,
          startTime: r.startTime.toISOString(),
          endTime: r.endTime.toISOString(),
          recurrence: r.recurrence,
          recurrenceEnd: r.recurrenceEnd
            ? r.recurrenceEnd.toISOString()
            : null,
        })),
        from,
        to
      );
    }
    case "create_note": {
      const [row] = await db
        .insert(notes)
        .values({ title: args.title ?? null, body: args.body })
        .returning();
      return row;
    }
    case "search_notes": {
      const q = (args.query ?? "").trim();
      const rows = await db
        .select()
        .from(notes)
        .where(
          q
            ? or(ilike(notes.body, `%${q}%`), ilike(notes.title, `%${q}%`))
            : undefined
        )
        .orderBy(desc(notes.createdAt))
        .limit(20);
      return rows;
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}
