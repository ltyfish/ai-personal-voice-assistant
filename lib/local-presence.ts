"use client";

// Local-computer presence: is the bridge up, and what local AI backends does it
// expose? Jarvis uses this to (a) show/hide the "Local" tab and (b) decide which
// model modes (local / hybrid) are even offerable. When the bridge is offline we
// fall back to cloud/mobile-safe features only — the whole point of the split.

import { useCallback, useEffect, useRef, useState } from "react";
import { getBridgeUrl, getBridgeToken } from "./bridge";

// `fllm`/`models` = freellmapi gateway (still used by Coding mode's chat relay).
// Voice turns now run on JARVIS's own native tool loop, so no local "brain" probe.
export type LocalStatus = {
  bridge: boolean; // bridge process reachable
  fllm: boolean; // freellmapi gateway up (Coding-mode chat backend)
  models: string[]; // model ids (from freellmapi /v1/models)
  shellEnabled: boolean;
};

const OFFLINE: LocalStatus = {
  bridge: false,
  fllm: false,
  models: [],
  shellEnabled: false,
};

export async function fetchLocalStatus(): Promise<LocalStatus> {
  const token = getBridgeToken();
  if (!token) return OFFLINE;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${getBridgeUrl()}/local/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return OFFLINE;
    const d = await res.json();
    return {
      bridge: true,
      fllm: !!d.fllm,
      models: Array.isArray(d.models) ? d.models : [],
      shellEnabled: !!d.shellEnabled,
    };
  } catch {
    return OFFLINE;
  }
}

// Poll presence on an interval so the Local tab appears/disappears as the
// computer comes online or goes to sleep. 15s is responsive without hammering.
export function useLocalPresence(intervalMs = 15_000) {
  const [status, setStatus] = useState<LocalStatus>(OFFLINE);
  const [checkedOnce, setCheckedOnce] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    const s = await fetchLocalStatus();
    setStatus(s);
    setCheckedOnce(true);
  }, []);

  useEffect(() => {
    check();
    timer.current = setInterval(check, intervalMs);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [check, intervalMs]);

  return { status, checkedOnce, refresh: check };
}
