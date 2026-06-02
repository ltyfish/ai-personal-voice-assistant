import { and, asc, desc, eq, gte, lte, ilike, or } from "drizzle-orm";
import { db, tasks, events, notes } from "@/db";

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
          due_date: { type: "string", description: "ISO 8601 datetime with timezone offset, or null" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_task",
      description: "Update a task by id. Use to mark done, reschedule, or change priority/title.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          notes: { type: "string" },
          done: { type: "boolean" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          due_date: { type: "string", description: "ISO 8601 datetime, or null to clear" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_task",
      description: "Delete a task by id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
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
      description: "Create a timed calendar event with a start and end time.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          location: { type: "string" },
          start_time: { type: "string", description: "ISO 8601 datetime with timezone offset" },
          end_time: { type: "string", description: "ISO 8601 datetime with timezone offset" },
        },
        required: ["title", "start_time", "end_time"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_event",
      description: "Delete a calendar event by id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
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
export async function runTool(name: string, args: Args): Promise<unknown> {
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
      const patch: Args = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.notes !== undefined) patch.notes = args.notes;
      if (args.done !== undefined) patch.done = args.done;
      if (args.priority !== undefined) patch.priority = args.priority;
      if (args.due_date !== undefined)
        patch.dueDate = args.due_date ? new Date(args.due_date) : null;
      const [row] = await db
        .update(tasks)
        .set(patch)
        .where(eq(tasks.id, args.id))
        .returning();
      return row ?? { error: "task not found" };
    }
    case "delete_task": {
      const [row] = await db
        .delete(tasks)
        .where(eq(tasks.id, args.id))
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
        })
        .returning();
      return row;
    }
    case "delete_event": {
      const [row] = await db
        .delete(events)
        .where(eq(events.id, args.id))
        .returning();
      return row ? { deleted: true } : { error: "event not found" };
    }
    case "list_events": {
      const rows = await db
        .select()
        .from(events)
        .where(
          and(
            gte(events.startTime, new Date(args.from)),
            lte(events.startTime, new Date(args.to))
          )
        )
        .orderBy(asc(events.startTime));
      return rows;
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
