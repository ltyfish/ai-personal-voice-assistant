// Pure helpers for expanding recurring events into concrete occurrences.
// Safe to import from both server (API/agent) and client (dashboard).

export type Recurrence = "none" | "daily" | "weekly" | "monthly";

export type BaseEvent = {
  id: string;
  title: string;
  location: string | null;
  startTime: string;
  endTime: string;
  recurrence?: Recurrence;
  recurrenceEnd?: string | null;
  // When set, this event is scheduled time for a project (a "project event").
  projectId?: string | null;
};

export type Occurrence = BaseEvent & {
  occurrenceId: string; // unique per concrete instance
  recurring: boolean;
};

function addStep(d: Date, rec: Recurrence): Date {
  const n = new Date(d);
  if (rec === "daily") n.setDate(n.getDate() + 1);
  else if (rec === "weekly") n.setDate(n.getDate() + 7);
  else if (rec === "monthly") n.setMonth(n.getMonth() + 1);
  return n;
}

// Expand events into individual occurrences that fall within [from, to].
export function expandEvents(
  events: BaseEvent[],
  from: Date,
  to: Date
): Occurrence[] {
  const out: Occurrence[] = [];

  for (const ev of events) {
    const rec = (ev.recurrence ?? "none") as Recurrence;
    const start = new Date(ev.startTime);
    const end = new Date(ev.endTime);
    const durationMs = end.getTime() - start.getTime();
    const hardEnd = ev.recurrenceEnd ? new Date(ev.recurrenceEnd) : null;

    if (rec === "none") {
      if (start >= from && start <= to) {
        out.push({ ...ev, occurrenceId: ev.id, recurring: false });
      }
      continue;
    }

    // Walk forward from the original start until we pass the window/cap.
    let cursor = new Date(start);
    let guard = 0;
    while (cursor <= to && guard < 750) {
      guard++;
      if (hardEnd && cursor > hardEnd) break;
      if (cursor >= from) {
        const occStart = new Date(cursor);
        const occEnd = new Date(cursor.getTime() + durationMs);
        out.push({
          ...ev,
          startTime: occStart.toISOString(),
          endTime: occEnd.toISOString(),
          occurrenceId: `${ev.id}:${occStart.toISOString()}`,
          recurring: true,
        });
      }
      cursor = addStep(cursor, rec);
    }
  }

  out.sort(
    (a, b) =>
      new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  );
  return out;
}
