import { desc, eq } from "drizzle-orm";
import { groq, FALLBACK_MODELS } from "./groq";
import { toolDefs, runTool } from "./tools";
import { db, tasks, events } from "@/db";

// Compact snapshot of current data so the model knows what actually exists
// (and whether a name like "meeting" is a task or an event).
async function buildSnapshot(): Promise<string> {
  const [openTasks, allEvents] = await Promise.all([
    db
      .select({ title: tasks.title, dueDate: tasks.dueDate })
      .from(tasks)
      .where(eq(tasks.done, false))
      .orderBy(desc(tasks.createdAt))
      .limit(30),
    db
      .select({
        title: events.title,
        startTime: events.startTime,
        recurrence: events.recurrence,
      })
      .from(events)
      .orderBy(desc(events.createdAt))
      .limit(30),
  ]);

  const fmt = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat("en-CA", {
          timeZone: TZ,
          dateStyle: "short",
          timeStyle: "short",
        }).format(d)
      : "no date";

  const taskLines = openTasks.length
    ? openTasks.map((t) => `  - "${t.title}" (due ${fmt(t.dueDate)})`).join("\n")
    : "  (none)";
  const eventLines = allEvents.length
    ? allEvents
        .map(
          (e) =>
            `  - "${e.title}" (${fmt(e.startTime)}${
              e.recurrence !== "none" ? `, repeats ${e.recurrence}` : ""
            })`
        )
        .join("\n")
    : "  (none)";

  return `\nThe user's CURRENT data (use this to choose the right tool — a name may be a TASK or an EVENT):\nOPEN TASKS:\n${taskLines}\nEVENTS:\n${eventLines}\n`;
}

// Try each model in turn; on a 429 (daily token limit) fall through to the next.
async function complete(messages: any[]) {
  let lastErr: any;
  for (const model of FALLBACK_MODELS) {
    try {
      return await groq.chat.completions.create({
        model,
        messages,
        tools: toolDefs,
        tool_choice: "auto",
        temperature: 0.2,
      });
    } catch (err: any) {
      if (err?.status === 429) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

const TZ = process.env.ASSISTANT_TIMEZONE || "Asia/Singapore";

async function systemPrompt() {
  const now = new Date();
  const localNow = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    dateStyle: "full",
    timeStyle: "short",
  }).format(now);
  const snapshot = await buildSnapshot();
  return `You are a personal assistant managing the user's tasks, calendar events, and notes.

Current date/time: ${localNow} (timezone ${TZ}). The current ISO instant is ${now.toISOString()}.
When the user says relative times like "tomorrow 7pm" or "Friday", resolve them to a full ISO 8601 datetime WITH the correct timezone offset for ${TZ}.

Rules:
- ALWAYS respond in English, no matter what language the user spoke in.
- To update or delete something, FIRST check the CURRENT data below to see whether the name is a TASK or an EVENT, then call the matching tool (update_task/delete_task vs update_event/delete_event). Pass its "title" (the words the user said) — the system matches it. Do NOT invent UUID ids.
- "Move/reschedule X to <time>": if X is an event, update_event with new start/end; if X is a task, update_task with a new due_date. Use the CURRENT data to decide which.
- Time: convert 12-hour speech to 24-hour. "7 pm" = 19:00, "7 am" = 07:00, "noon" = 12:00. Always include the ${TZ} timezone offset in the ISO string, NOT a "Z"/UTC time.
- Things the user must DO are tasks. Things at a specific time are calendar events. Reminders without a clear time become tasks with a due date.
- "Every Monday / every day / monthly" means a recurring event: set recurrence accordingly and put start_time on the correct first occurrence (e.g. the next Monday).
- To move/reschedule an event ("move gym to 8pm", "push the meeting to Friday"), first list_events to find its id, then call update_event with the new time.
- To answer "what do I have today / what's next / this week", call list_events AND list_tasks first, then answer from the results.
- If a question has MULTIPLE parts (e.g. "what's my task today and lunch on Monday"), make a separate tool call for each part with the correct date range, then answer every part. For a named weekday like "Monday", compute that specific date's range (00:00 to 23:59).
- Recurring events only appear in list_events when the queried range covers an occurrence, so use the actual target date range, not just today.
- After doing the work, reply in ONE short, natural spoken sentence. It will be read aloud, so no markdown, lists, or IDs.
- Never invent data. If a query returns nothing, say so plainly.
${snapshot}`;
}

export type AgentResult = {
  reply: string;
  actions: { name: string; args: any; result: unknown }[];
};

// Runs a tool-calling loop until the model produces a final spoken reply.
export async function runAgent(userText: string): Promise<AgentResult> {
  const messages: any[] = [
    { role: "system", content: await systemPrompt() },
    { role: "user", content: userText },
  ];
  const actions: AgentResult["actions"] = [];
  // Cache results of identical calls so a stuck model can't repeat a write
  // (e.g. creating the same event 6 times until it hits the step cap).
  const seen = new Map<string, unknown>();

  for (let step = 0; step < 6; step++) {
    const completion = await complete(messages);

    const msg = completion.choices[0].message;
    // Re-add only standard fields. Some models (gpt-oss) return a `reasoning`
    // field that other models reject on the next request, breaking fallback.
    const assistantMsg: any = { role: "assistant", content: msg.content ?? "" };
    if (msg.tool_calls?.length) assistantMsg.tool_calls = msg.tool_calls;
    messages.push(assistantMsg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { reply: msg.content?.trim() || "Done.", actions };
    }

    for (const call of msg.tool_calls) {
      let args: any = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        /* leave args empty on parse failure */
      }
      // Model sometimes emits "null" or a non-object — normalize to {}.
      if (args === null || typeof args !== "object") args = {};

      const sig = `${call.function.name}:${JSON.stringify(args)}`;
      let result: unknown;
      if (seen.has(sig)) {
        // Identical call already done this turn — don't write again.
        result = { ...(seen.get(sig) as object), note: "already done" };
      } else {
        result = await runTool(call.function.name, args);
        seen.set(sig, result);
        actions.push({ name: call.function.name, args, result });
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Hit the step cap — force one final plain-text summary instead of failing.
  try {
    const summary = await groq.chat.completions.create({
      model: FALLBACK_MODELS[0],
      messages: [
        ...messages,
        {
          role: "user",
          content:
            "In one short English sentence, tell me what you just did. Do not call any tools.",
        },
      ],
      temperature: 0.2,
    });
    return {
      reply: summary.choices[0].message.content?.trim() || "Done.",
      actions,
    };
  } catch {
    return { reply: "Done.", actions };
  }
}
