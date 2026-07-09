import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  selectPetVisualState,
  shouldRestoreIdleAfterDrag,
} from "../shared/pet-visual-state.js";
import { selectRandomPetImage } from "../shared/random-pet-image.js";
import {
  MAX_CAPTURE_MS,
  shouldStopForSilence,
} from "../shared/voice-capture.js";
import type {
  DesktopLocalActionIntent,
  DesktopStatus,
  PetImagePools,
  PetMode,
  PetVisualState,
  VoiceTurnResult,
  WindowBounds,
} from "../shared/types.js";
import approvalPet from "./assets/pet/approval.png";
import deniedPet from "./assets/pet/denied.png";
import idlePet from "./assets/pet/idle.png";
import listeningPet from "./assets/pet/listening.png";
import talkingPet from "./assets/pet/talking.png";
import thinkingPet from "./assets/pet/thinking.png";
import { speak, stopSpeaking } from "./voice.js";
import { startWakeListener, type WakeHandle } from "./wake.js";

const bundledPetImages: Record<PetVisualState, string> = {
  idle: idlePet,
  dragging: idlePet,
  listening: listeningPet,
  thinking: thinkingPet,
  approval: approvalPet,
  denied: deniedPet,
  approved: approvalPet,
  talking: talkingPet,
};

export default function App() {
  const wakeRef = useRef<WakeHandle | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startScreenX: number;
    startScreenY: number;
    bounds: WindowBounds;
    moved: boolean;
  } | null>(null);
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [mode, setMode] = useState<PetMode>("idle");
  const [promptOpen, setPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [wakeScore, setWakeScore] = useState(0);
  const [wakeIssue, setWakeIssue] = useState("");
  const [pendingAction, setPendingAction] = useState<DesktopLocalActionIntent | null>(null);
  const [actionRows, setActionRows] = useState<string[]>([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [petImagePools, setPetImagePools] = useState<PetImagePools>({});
  const [petImage, setPetImage] = useState(bundledPetImages.idle);
  const [dragging, setDragging] = useState(false);
  const [transientState, setTransientState] = useState<"approved" | "denied" | null>(null);
  const transientTimerRef = useRef<number | null>(null);
  const lastPetImagesRef = useRef<Partial<Record<PetVisualState, string>>>({});
  const failedPetImagesRef = useRef<Partial<Record<PetVisualState, Set<string>>>>({});
  const previousPetVisualStateRef = useRef<PetVisualState | null>(null);
  const sleeping = mode === "sleeping";
  const petVisualState = selectPetVisualState({
    dragging,
    transient: transientState,
    hasPendingAction: Boolean(pendingAction),
    mode,
  });
  const choosePetImage = useCallback((state: PetVisualState, pools = petImagePools) => {
    const failed = failedPetImagesRef.current[state] || new Set<string>();
    const selected = selectRandomPetImage(
      pools[state] || [],
      lastPetImagesRef.current[state],
      failed,
    ) || bundledPetImages[state];
    lastPetImagesRef.current[state] = selected;
    setPetImage(selected);
  }, [petImagePools]);

  useEffect(() => {
    window.jarvisDesktop.getStatus().then((next) => {
      setStatus(next);
      setMode(next.petMode);
    });
  }, []);

  useEffect(() => {
    let active = true;
    void window.jarvisDesktop.getPetImages().then((pools) => {
      if (!active) return;
      failedPetImagesRef.current = {};
      setPetImagePools(pools);
    });
    const unsubscribe = window.jarvisDesktop.onPetImagesChanged((pools) => {
      failedPetImagesRef.current = {};
      setPetImagePools(pools);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const previous = previousPetVisualStateRef.current;
    previousPetVisualStateRef.current = petVisualState;
    if (shouldRestoreIdleAfterDrag(previous, petVisualState)) {
      setPetImage(lastPetImagesRef.current.idle || bundledPetImages.idle);
      return;
    }
    choosePetImage(petVisualState);
  }, [choosePetImage, petVisualState]);

  useEffect(() => {
    if (petVisualState !== "idle") return;
    const timer = window.setInterval(() => choosePetImage("idle"), 300_000);
    return () => window.clearInterval(timer);
  }, [choosePetImage, petVisualState]);

  useEffect(() => {
    return () => {
      if (transientTimerRef.current) window.clearTimeout(transientTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      window.jarvisDesktop.getStatus().then(setStatus).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void window.jarvisDesktop.setPromptDockOpen(!sleeping && promptOpen);
  }, [promptOpen, sleeping]);

  useEffect(() => {
    if (!status?.wakeEnabled || wakeRef.current) return;
    let cancelled = false;
    startWakeListener(
      () => {
        const handle = wakeRef.current;
        if (handle) void captureVoiceTurn(handle);
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
        setWakeIssue("Wake unavailable");
      });

    return () => {
      cancelled = true;
      wakeRef.current?.stop();
      wakeRef.current = null;
    };
  }, [status?.wakeEnabled]);

  async function setPetMode(nextMode: PetMode) {
    const cfg = await window.jarvisDesktop.setPetMode(nextMode);
    setMode(cfg.petMode);
    if (cfg.petMode === "sleeping") setPromptOpen(false);
  }

  async function togglePrompt() {
    void wakeRef.current?.ensureRunning().then((running) => {
      if (running) setWakeIssue("");
    });
    if (sleeping) {
      await setPetMode("idle");
      setPromptOpen(true);
      return;
    }
    setPromptOpen((open) => !open);
  }

  async function handleOrbPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    setDragging(false);
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = await window.jarvisDesktop.getWindowBounds();
    dragRef.current = {
      pointerId: event.pointerId,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      bounds,
      moved: false,
    };
  }

  function handleOrbPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.screenX - drag.startScreenX;
    const deltaY = event.screenY - drag.startScreenY;
    if (!drag.moved) {
      if (Math.hypot(deltaX, deltaY) < 4) return;
      drag.moved = true;
      setDragging(true);
    }
    void window.jarvisDesktop.setWindowBounds({
      ...drag.bounds,
      x: drag.bounds.x + deltaX,
      y: drag.bounds.y + deltaY,
    });
  }

  function handleOrbPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (!drag.moved) void togglePrompt();
  }

  async function submit() {
    const text = prompt.trim();
    if (!text || mode === "thinking") return;
    setTranscript(text);
    setMode("thinking");
    setReply("Sending...");
    try {
      const result = await window.jarvisDesktop.runTextTurn(text);
      handleTurnResult(result, text);
    } catch (error) {
      setReply(error instanceof Error ? error.message : "JARVIS failed to send.");
      setMode("offline");
    }
  }

  function summarizeActions(actions: unknown[] | undefined) {
    if (!Array.isArray(actions)) return [];
    return actions
      .map((action) => {
        const record = action as { name?: unknown; result?: unknown };
        const name = String(record.name || "action");
        const result = record.result as { local_action?: unknown; label?: unknown; error?: unknown } | undefined;
        if (result?.local_action) return `${name}: waiting for approval (${String(result.label || result.local_action)})`;
        if (result?.error) return `${name}: ${String(result.error)}`;
        return name;
      })
      .slice(0, 4);
  }

  function findLocalAction(actions: unknown[] | undefined): DesktopLocalActionIntent | null {
    if (!Array.isArray(actions)) return null;
    for (const action of actions) {
      const result = (action as { result?: Partial<DesktopLocalActionIntent> }).result;
      if (!result?.local_action) continue;
      if (
        result.local_action === "open" ||
        result.local_action === "open_app" ||
        result.local_action === "whatsapp_send" ||
        result.local_action === "shutdown" ||
        result.local_action === "run_shell"
      ) {
        return {
          local_action: result.local_action,
          target: result.target,
          label: result.label || result.target || result.command || result.local_action,
          fallback: result.fallback,
          only: result.only,
          command: result.command,
          autoSend: result.autoSend,
          delaySec: result.delaySec,
          cancel: result.cancel,
        };
      }
    }
    return null;
  }

  function actionQuestion(intent: DesktopLocalActionIntent) {
    if (intent.local_action === "run_shell") return `Run this command: ${intent.label}?`;
    if (intent.local_action === "shutdown") return `${intent.label}?`;
    if (intent.local_action === "whatsapp_send") return `Send ${intent.label}?`;
    return `Open ${intent.label} on this computer?`;
  }

  function handleTurnResult(result: VoiceTurnResult, fallbackTranscript = "") {
    if (result.transcript || fallbackTranscript) setTranscript(result.transcript || fallbackTranscript);
    setActionRows(summarizeActions(result.actions));
    const nextAction = findLocalAction(result.actions);
    if (nextAction) {
      setPendingAction(nextAction);
      setPromptOpen(true);
      setReply(actionQuestion(nextAction));
      setMode("idle");
      return;
    }
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
  }

  function directMicStream() {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  }

  async function captureVoiceTurn(handle: WakeHandle | null) {
    if (mode === "thinking" || mode === "speaking" || recorderRef.current) return;
    let stream: MediaStream;
    try {
      stream = handle?.stream || (await directMicStream());
    } catch (error) {
      setWakeIssue("Mic blocked");
      setPromptOpen(true);
      setReply(error instanceof Error ? error.message : "Microphone access was blocked.");
      setMode("offline");
      return;
    }
    const shouldStopStream = !handle;
    if (!stream || typeof MediaRecorder === "undefined") {
      if (shouldStopStream) stream?.getTracks().forEach((track) => track.stop());
      setWakeIssue("Mic recorder unavailable");
      setPromptOpen(true);
      setReply("I heard Jarvis, but voice capture is unavailable. Type your command.");
      return;
    }
    handle?.pause();
    setPromptOpen(true);
    setMode("listening");
    setTranscript("");
    setReply("Listening...");
    const chunks: Blob[] = [];
    const preferredType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const recorder = new MediaRecorder(stream, { mimeType: preferredType });
    recorderRef.current = recorder;
    const captureStartedAt = performance.now();
    let analysisFrame = 0;
    let audioContext: AudioContext | null = null;
    let speechObserved = false;
    let silenceStartedAt: number | null = null;
    let analysisClosed = false;

    function stopAnalysis() {
      if (analysisClosed) return;
      analysisClosed = true;
      if (analysisFrame) window.cancelAnimationFrame(analysisFrame);
      if (audioContext) void audioContext.close().catch(() => undefined);
    }

    try {
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);
      const levels = new Uint8Array(analyser.fftSize);

      const analyse = () => {
        if (recorder.state === "inactive") return;
        analyser.getByteTimeDomainData(levels);
        let energy = 0;
        for (const level of levels) {
          const normalized = (level - 128) / 128;
          energy += normalized * normalized;
        }
        const rms = Math.sqrt(energy / levels.length);
        const now = performance.now();
        if (rms >= 0.018) {
          speechObserved = true;
          silenceStartedAt = null;
        } else if (speechObserved && silenceStartedAt == null) {
          silenceStartedAt = now;
        }
        if (
          shouldStopForSilence({
            elapsedMs: now - captureStartedAt,
            speechObserved,
            silentForMs: silenceStartedAt == null ? 0 : now - silenceStartedAt,
          })
        ) {
          recorder.stop();
          return;
        }
        analysisFrame = window.requestAnimationFrame(analyse);
      };
      analysisFrame = window.requestAnimationFrame(analyse);
    } catch {
      stopAnalysis();
    }
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = async () => {
      stopAnalysis();
      recorderRef.current = null;
      if (!chunks.length) {
        setReply("I didn't catch that.");
        setMode("idle");
        if (shouldStopStream) stream.getTracks().forEach((track) => track.stop());
        handle?.resume();
        return;
      }
      const audio = new Blob(chunks, { type: preferredType });
      setMode("thinking");
      setReply("Thinking...");
      try {
        const bytes = await audio.arrayBuffer();
        const result = await window.jarvisDesktop.runAudioTurn({ bytes, type: audio.type });
        handleTurnResult(result);
      } catch (error) {
        setReply(error instanceof Error ? error.message : "Voice turn failed.");
        setMode("offline");
      } finally {
        if (shouldStopStream) stream.getTracks().forEach((track) => track.stop());
        handle?.resume();
      }
    };
    recorder.start();
    window.setTimeout(() => {
      if (recorderRef.current === recorder && recorder.state !== "inactive") recorder.stop();
    }, MAX_CAPTURE_MS);
  }

  async function manualListen() {
    setPromptOpen(true);
    try {
      const handle = wakeRef.current;
      if (handle) {
        const running = await handle.ensureRunning();
        if (running) setWakeIssue("");
        await captureVoiceTurn(handle);
        return;
      }
      await captureVoiceTurn(null);
    } catch (error) {
      setWakeIssue("Listen failed");
      setReply(error instanceof Error ? error.message : "Listening failed.");
      setMode("offline");
    }
  }

  async function openJarvis() {
    const result = await window.jarvisDesktop.openFullJarvis();
    if (!result.ok) {
      setPromptOpen(true);
      setReply(result.error || "Could not open JARVIS.");
      setMode("offline");
    }
  }

  async function continuePendingAction() {
    if (!pendingAction || actionBusy) return;
    setActionBusy(true);
    setTransientState("approved");
    setReply("Running...");
    const result = await window.jarvisDesktop.runLocalAction(pendingAction);
    setActionBusy(false);
    setPendingAction(null);
    setTransientState(null);
    setReply(result.message);
    if (result.output) setActionRows([result.output]);
    if (status?.voiceEnabled !== false) {
      setMode("speaking");
      speak(result.message, () => setMode("idle"));
    } else {
      setMode("idle");
    }
  }

  function stopPendingAction() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
      return;
    }
    const deniedApproval = Boolean(pendingAction);
    setPendingAction(null);
    setReply("Stopped.");
    stopSpeaking();
    setMode("idle");
    if (deniedApproval) {
      setTransientState("denied");
      if (transientTimerRef.current) window.clearTimeout(transientTimerRef.current);
      transientTimerRef.current = window.setTimeout(() => setTransientState(null), 1400);
    }
  }

  return (
    <main className={`pet-shell mode-${mode} pet-${petVisualState} ${promptOpen ? "prompt-open" : "prompt-closed"}`}>
      <button
        className="pet-character"
        onPointerDown={handleOrbPointerDown}
        onPointerMove={handleOrbPointerMove}
        onPointerUp={handleOrbPointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragging(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void togglePrompt();
          }
        }}
        aria-label={promptOpen ? "Hide JARVIS prompt" : "Show JARVIS prompt"}
        aria-expanded={promptOpen}
      >
        <img
          key={`${petVisualState}:${petImage}`}
          src={petImage}
          alt=""
          draggable={false}
          onError={() => {
            if (petImage === bundledPetImages[petVisualState]) return;
            const failed = failedPetImagesRef.current[petVisualState] || new Set<string>();
            failed.add(petImage);
            failedPetImagesRef.current[petVisualState] = failed;
            choosePetImage(petVisualState);
          }}
        />
        <span className="pet-shadow" />
      </button>

      {!sleeping && promptOpen && (
        <section className="prompt-dock" aria-label="JARVIS prompt">
          <div className="prompt-row">
            <textarea
              value={prompt}
              rows={1}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="Ask JARVIS..."
            />
            <button className="send-button" onClick={submit} disabled={!prompt.trim() || mode === "thinking"}>
              Send
            </button>
          </div>

          <div className="pet-actions">
            <button onClick={manualListen} disabled={mode === "thinking" || mode === "speaking" || !!recorderRef.current}>
              Listen
            </button>
            <button onClick={openJarvis}>Open JARVIS</button>
            <button
              onClick={() => {
                stopPendingAction();
              }}
            >
              Stop
            </button>
            <button onClick={() => setPetMode("sleeping")}>Sleep</button>
          </div>

          <div className="pet-status" title={wakeIssue || `Wake ${wakeScore.toFixed(2)} / Local ${status?.bridgeOnline ? "on" : "off"}`}>
            <span className={`status-dot ${status?.bridgeOnline ? "online" : ""}`} />
            <span>{mode === "thinking" ? "Thinking" : mode === "listening" ? "Listening" : wakeIssue || "Ready"}</span>
          </div>

          {pendingAction && (
            <div className="approval-card">
              <p>{actionQuestion(pendingAction)}</p>
              {pendingAction.command && <pre>{pendingAction.command}</pre>}
              <div>
                <button onClick={continuePendingAction} disabled={actionBusy}>
                  {actionBusy ? "Running..." : "Continue"}
                </button>
                <button onClick={stopPendingAction} disabled={actionBusy}>
                  Stop
                </button>
              </div>
            </div>
          )}

          {transcript && (
            <p className="transcript">
              <strong>You</strong> {transcript}
            </p>
          )}
          {reply && <p className="reply">{reply}</p>}
          {actionRows.length > 0 && (
            <div className="action-list">
              {actionRows.map((row, index) => (
                <p key={`${row}-${index}`}>{row}</p>
              ))}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
