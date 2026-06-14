// Curated capability ranking for the free-tier models the rotation proxy serves.
// Lower rank = stronger / preferred, so the Pipeline dashboard can show the best
// models at the top by default. Matched case-insensitively against the model id
// (first pattern wins). Anything unmatched sorts to the bottom (999) but keeps a
// stable secondary order (alphabetical) at the call site. Pure data — safe to
// import on the client. Tweak the list as new free models appear.
const RANK_PATTERNS: [RegExp, number][] = [
  [/gpt-oss-120b/i, 10],
  [/llama-4-maverick/i, 18],
  [/llama-3\.3-70b/i, 20],
  [/qwen3-?coder|qwen3-?235/i, 28],
  [/deepseek/i, 32],
  [/qwen3-?32/i, 36],
  [/gemini-3|gemini-2\.5-pro/i, 40],
  [/gemini-2\.5-flash(?!-lite)/i, 50],
  [/mistral-(large|medium)/i, 55],
  [/llama-4-scout/i, 60],
  [/gpt-oss-20b/i, 65],
  [/gemini.*flash-lite/i, 70],
  [/qwen3-?(8|14|30)/i, 75],
];

export function modelRank(model: string): number {
  for (const [re, r] of RANK_PATTERNS) if (re.test(model)) return r;
  return 999;
}

// Sort helper: best (lowest rank) first, ties broken alphabetically so the order
// is stable across reloads.
export function byBestModel<T>(get: (t: T) => string) {
  return (a: T, b: T) => {
    const ra = modelRank(get(a));
    const rb = modelRank(get(b));
    if (ra !== rb) return ra - rb;
    return get(a).localeCompare(get(b));
  };
}
