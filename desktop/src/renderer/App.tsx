import { useEffect, useRef, useState } from "react";
import type { DesktopStatus, PetMode } from "../shared/types.js";
import { speak, stopSpeaking } from "./voice.js";
import { startWakeListener, type WakeHandle } from "./wake.js";

export default function App() {
  const wakeRef = useRef<WakeHandle | null>(null);
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [mode, setMode] = useState<PetMode>("idle");
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState("");
  const [wakeScore, setWakeScore] = useState(0);

  useEffect(() => {
    window.jarvisDesktop.getStatus().then((next) => {
      setStatus(next);
      setMode(next.petMode);
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      window.jarvisDesktop.getStatus().then(setStatus).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!status?.wakeEnabled || wakeRef.current) return;
    let cancelled = false;
    startWakeListener(
      () => {
        setMode("listening");
        setReply("I heard Jarvis.");
      },
      setWakeScore,
    )
      .then((handle) => {
        if (cancelled) {
          handle.stop();
          return;
        }
        wakeRef.current = handle;
      })
      .catch(() => {
        wakeRef.current = null;
      });

    return () => {
      cancelled = true;
      wakeRef.current?.stop();
      wakeRef.current = null;
    };
  }, [status?.wakeEnabled]);

  async function refreshStatus() {
    const next = await window.jarvisDesktop.getStatus();
    setStatus(next);
    setMode(next.petMode);
  }

  async function setPetMode(nextMode: PetMode) {
    const cfg = await window.jarvisDesktop.setPetMode(nextMode);
    setMode(cfg.petMode);
  }

  async function saveStatusPatch(patch: Parameters<typeof window.jarvisDesktop.saveConfig>[0]) {
    const cfg = await window.jarvisDesktop.saveConfig(patch);
    setStatus((current) =>
      current
        ? {
            ...current,
            startupEnabled: cfg.startupEnabled,
            wakeEnabled: cfg.wakeEnabled,
            voiceEnabled: cfg.voiceEnabled,
            petMode: cfg.petMode,
          }
        : current,
    );
    setMode(cfg.petMode);
  }

  async function submit() {
    const text = prompt.trim();
    if (!text) return;
    setMode("thinking");
    setReply("Sending...");
    try {
      const result = await window.jarvisDesktop.runTextTurn(text);
      const spoken = result.reply || result.error || "No reply.";
      setReply(spoken);
      if (result.error) {
        setMode("offline");
        return;
      }
      if (status?.voiceEnabled !== false) {
        setMode("speaking");
        speak(spoken, () => setMode("idle"));
      } else {
        setMode("idle");
      }
    } catch (error) {
      setReply(error instanceof Error ? error.message : "JARVIS failed to send.");
      setMode("offline");
    }
  }

  async function restartBridge() {
    const next = await window.jarvisDesktop.restartBridge();
    setStatus(next);
  }

  const sleeping = mode === "sleeping";

  return (
    <main className={`pet-shell mode-${mode}`}>
      <button className="orb" onClick={() => setPetMode(sleeping ? "idle" : "sleeping")} aria-label="Toggle JARVIS sleep">
        <span className="orb-core" />
        <span className="orb-ring" />
      </button>

      {!sleeping && (
        <section className="panel" aria-label="JARVIS prompt panel">
          <div className="header">
            <div>
              <strong>J.A.R.V.I.S.</strong>
              <span>{status?.backendUrl || "Starting JARVIS..."}</span>
              <span>Wake {wakeScore.toFixed(2)} · Bridge {status?.bridgeOnline ? "on" : "off"}</span>
            </div>
            <button onClick={() => setPetMode("sleeping")}>Sleep</button>
          </div>

          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void submit();
            }}
            placeholder="Type a prompt..."
          />

          <div className="actions">
            <button onClick={submit} disabled={!prompt.trim() || mode === "thinking"}>
              Send
            </button>
            <button
              onClick={() => {
                stopSpeaking();
                setMode("idle");
              }}
            >
              Stop
            </button>
            <button onClick={restartBridge}>Bridge</button>
            <button onClick={() => window.jarvisDesktop.openFullJarvis()}>Open</button>
          </div>

          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={status?.wakeEnabled ?? true}
                onChange={(event) => saveStatusPatch({ wakeEnabled: event.target.checked })}
              />
              Wake
            </label>
            <label>
              <input
                type="checkbox"
                checked={status?.voiceEnabled ?? true}
                onChange={(event) => saveStatusPatch({ voiceEnabled: event.target.checked })}
              />
              Voice
            </label>
            <label>
              <input
                type="checkbox"
                checked={status?.startupEnabled ?? true}
                onChange={(event) => saveStatusPatch({ startupEnabled: event.target.checked })}
              />
              Startup
            </label>
            <button onClick={refreshStatus}>Refresh</button>
          </div>

          {reply && <p className="reply">{reply}</p>}
        </section>
      )}
    </main>
  );
}
