// Tiny per-instance TTL cache for rarely-changing config reads. Fluid Compute
// reuses a warm function instance across requests, so memoizing a value for a few
// seconds lets most turns skip a Neon round-trip entirely. Values that change
// only on an explicit user action (router config, model toggles, behavior text)
// tolerate a few seconds of staleness; the writer can call `bust()` to clear it.
//
// Deliberately NOT used for anything that changes every turn (key cooldowns,
// per-request snapshots) — those must stay live.

type Entry<T> = { value: T; at: number };

export function ttlCache<T>(fn: () => Promise<T>, ttlMs: number): {
  get: () => Promise<T>;
  bust: () => void;
} {
  let entry: Entry<T> | null = null;
  let inflight: Promise<T> | null = null;
  return {
    async get() {
      const now = Date.now();
      if (entry && now - entry.at < ttlMs) return entry.value;
      // Coalesce concurrent misses into one upstream read.
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const value = await fn();
          entry = { value, at: Date.now() };
          return value;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    bust() {
      entry = null;
    },
  };
}
