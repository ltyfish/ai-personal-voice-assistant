// Short, speech-friendly references for items: "Task 3", "Event 2", "Note 4".
// Built from each table's persistent `seq` column so a ref always points at the
// same row until it's deleted. Lets the voice agent (and the user) target an
// exact item without fuzzy title matching or guessing task-vs-event.
//
// We use the FULL type word ("task"/"event"/"note") rather than a single letter
// because Whisper transcribes whole words reliably but mangles single letters
// ("t3" came through as "T tree"). The word also anchors the number so STT
// can't merge it into a neighbouring word.

export type RefKind = "task" | "event" | "note" | "project";

// Human/spoken form shown in the UI and snapshot, e.g. "Task 3".
export function refOf(kind: RefKind, seq: number): string {
  const word = kind[0].toUpperCase() + kind.slice(1);
  return `${word} ${seq}`;
}

// Number words → digits, so "task three" parses the same as "task 3".
const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

// Parse the trailing number from a string that may use digits or words
// ("3", "three", "twenty one", "twenty-one"). Returns null if none found.
function parseNumber(s: string): number | null {
  const digits = s.match(/\d+/);
  if (digits) return Number(digits[0]);
  const words = s.toLowerCase().split(/[\s-]+/).filter(Boolean);
  let total = 0;
  let matched = false;
  for (const w of words) {
    if (w in TENS) {
      total += TENS[w];
      matched = true;
    } else if (w in ONES) {
      total += ONES[w];
      matched = true;
    }
  }
  return matched ? total : null;
}

// Parse "Task 3", "task three", "t3", "#n4", "event twenty one" → { kind, seq }.
export function parseRef(raw: string): { kind: RefKind; seq: number } | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  let kind: RefKind | null = null;
  if (/\b(task|tasks)\b/.test(s) || /^#?t\d/.test(s)) kind = "task";
  else if (/\b(event|events)\b/.test(s) || /^#?e\d/.test(s)) kind = "event";
  else if (/\b(note|notes)\b/.test(s) || /^#?n\d/.test(s)) kind = "note";
  else if (/\b(project|projects)\b/.test(s) || /^#?p\d/.test(s)) kind = "project";
  if (!kind) return null;
  const seq = parseNumber(s);
  if (seq === null) return null;
  return { kind, seq };
}
