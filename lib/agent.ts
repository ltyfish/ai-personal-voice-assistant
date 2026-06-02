import { groq, DEFAULT_MODEL } from "./groq";
import { toolDefs, runTool } from "./tools";

const TZ = process.env.ASSISTANT_TIMEZONE || "Asia/Singapore";

function systemPrompt() {
  const now = new Date();
  const localNow = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    dateStyle: "full",
    timeStyle: "short",
  }).format(now);
  return `You are a personal assistant managing the user's tasks, calendar events, and notes.

Current date/time: ${localNow} (timezone ${TZ}). The current ISO instant is ${now.toISOString()}.
When the user says relative times like "tomorrow 7pm" or "Friday", resolve them to a full ISO 8601 datetime WITH the correct timezone offset for ${TZ}.

Rules:
- Things the user must DO are tasks. Things at a specific time are calendar events. Reminders without a clear time become tasks with a due date.
- To answer "what do I have today / what's next / this week", call list_events and/or list_tasks first, then answer from the results.
- After doing the work, reply in ONE short, natural spoken sentence. It will be read aloud, so no markdown, lists, or IDs.
- Never invent data. If a query returns nothing, say so plainly.`;
}

export type AgentResult = {
  reply: string;
  actions: { name: string; args: any; result: unknown }[];
};

// Runs a tool-calling loop until the model produces a final spoken reply.
export async function runAgent(userText: string): Promise<AgentResult> {
  const messages: any[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: userText },
  ];
  const actions: AgentResult["actions"] = [];

  for (let step = 0; step < 6; step++) {
    const completion = await groq.chat.completions.create({
      model: DEFAULT_MODEL,
      messages,
      tools: toolDefs,
      tool_choice: "auto",
      temperature: 0.2,
    });

    const msg = completion.choices[0].message;
    messages.push(msg);

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
      const result = await runTool(call.function.name, args);
      actions.push({ name: call.function.name, args, result });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return { reply: "I did several steps but couldn't wrap up — please check.", actions };
}
