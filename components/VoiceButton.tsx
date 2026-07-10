"use client";

import { useEffect, useRef, useState } from "react";
import type { WakeWordEngine } from "@/lib/wakeword";
import {
  runLocalAction,
  runShell,
  bridgeHealth,
  getBridgeUrl,
  getBridgeToken,
  setBridgeConfig,
  getUserProfile,
  setUserProfile,
  setDevMode,
  installAutostart,
  restartBridge,
  pageSnapshot,
  pageText,
  pageScroll,
  pageAct,
} from "@/lib/bridge";
import type { LoginState } from "@/lib/bridge";
import { getRelaySecret, setRelaySecret, fetchRelayPresence, relayConfigured } from "@/lib/relay-client";
import { LOCAL_TOOL_GROUPS, getDisabledGroups, setGroupEnabled, getEnabledLocalToolNames } from "@/lib/tool-config";
import type { LocalActionIntent } from "@/lib/local";
import { getModelMode } from "@/lib/local-mode";
import { useLocalPresence } from "@/lib/local-presence";
import { decideTurnRoute } from "@/lib/turn-route";
import {
  PIPER_VOICES,
  isPiperVoiceURI,
  piperVoiceId,
  piperVoiceURI,
  getPiperEngine,
} from "@/lib/piper";
import { runLocalTurn } from "@/lib/local-agent";
import { publishModel, logRoute, markThinking } from "@/lib/model-hud";
import SwirlOrb from "@/components/jarvis/SwirlOrb";
import { publishOrbState } from "@/lib/orb-state";
import { Select } from "@/components/ui/Field";

type Status = "idle" | "recording" | "thinking" | "confirming";

// Records the spoken command as raw PCM straight off an AudioContext and encodes
// a 16kHz mono WAV. This is the SAME audio path wake-word listening uses, which
// is why music stays full-quality while recording — unlike MediaRecorder, which
// flips Chrome/Windows into "communications" mode and ducks/muffles playback.
class PcmRecorder {
  onstop: (() => void) | null = null;
  private ctx: AudioContext;
  private src: MediaStreamAudioSourceNode;
  private node: ScriptProcessorNode;
  private chunks: Float32Array[] = [];
  private length = 0;
  private inRate: number;
  private active = false;

  constructor(stream: MediaStream) {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new Ctx();
    this.inRate = this.ctx.sampleRate;
    this.src = this.ctx.createMediaStreamSource(stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      if (!this.active) return;
      // Copy — the input buffer is reused by the browser after this callback.
      this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      this.length += this.node.bufferSize;
    };
  }

  start() {
    this.active = true;
    this.src.connect(this.node);
    // ScriptProcessor only pumps when connected to a destination; we never write
    // its output buffer, so it emits silence (no feedback to the speakers).
    this.node.connect(this.ctx.destination);
    void this.ctx.resume().catch(() => {});
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    try {
      this.node.disconnect();
      this.src.disconnect();
    } catch {
      /* already torn down */
    }
    this.onstop?.();
  }

  // Flatten captured audio to a 16kHz mono 16-bit PCM WAV. Closes the context.
  toWavBlob(): Blob {
    const merged = new Float32Array(this.length);
    let offset = 0;
    for (const c of this.chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    this.dispose();
    return encodeWav16k(merged, this.inRate);
  }

  dispose() {
    this.chunks = [];
    this.length = 0;
    void this.ctx.close().catch(() => {});
  }
}

// Linear-resample to 16kHz and write a mono 16-bit PCM WAV (RIFF/WAVE).
function encodeWav16k(input: Float32Array, inRate: number): Blob {
  const outRate = 16000;
  let data: Float32Array;
  if (inRate === outRate) {
    data = input;
  } else {
    const ratio = inRate / outRate;
    const outLen = Math.floor(input.length / ratio);
    data = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = i * ratio;
      const i0 = Math.floor(idx);
      const i1 = Math.min(i0 + 1, input.length - 1);
      data[i] = input[i0] + (input[i1] - input[i0]) * (idx - i0);
    }
  }
  const buffer = new ArrayBuffer(44 + data.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + data.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, outRate, true);
  view.setUint32(28, outRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, data.length * 2, true);
  let off = 44;
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

const DEFAULT_RECORD_MS = 8000; // how long to record after hearing "Jarvis"
const LIVE_IDLE_MS = 30000; // end a live session after this long with no speech

// Spoken phrases that start / end a live conversation (no wake word per turn).
const LIVE_ENTER_RE =
  /\b(live (mode|session|conversation)|conversation mode|let'?s (talk|chat)|start (a )?(live )?(conversation|chat|session)|keep listening)\b/;
const LIVE_EXIT_RE =
  /\b(end (the )?(live )?(session|conversation|chat)|stop listening|that'?s all|that'?ll be all|good ?bye|bye( jarvis)?|exit conversation|i'?m done|we'?re done|quit)\b/;

// Map the tools JARVIS invoked to the tab the user probably wants to see.
// Mutating tools win over list/read ones; first match by priority order.
function pickTabFromActions(
  actions: { name: string; result: any }[] | undefined
): string | null {
  if (!actions?.length) return null;
  const names = actions.map((a) => a.name);
  const has = (re: RegExp) => names.some((n) => re.test(n));
  if (has(/task/)) return "tasks";
  if (has(/event/)) return "calendar";
  if (has(/note/)) return "notes";
  if (has(/email/)) return "feed";
  return null;
}

export default function VoiceButton({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  // True when the last turn matched NO ability keyword (strict routing sent no
  // tools), so we can nudge the user toward the Abilities/keywords tab.
  const [typed, setTyped] = useState(""); // typed-command box (skip STT)
  const [listening, setListening] = useState(false);
  const [wakeBusy, setWakeBusy] = useState(false); // loading models / starting
  // Live conversation: after the first trigger, keep the mic looping so you can
  // talk back-and-forth without saying "Jarvis" every turn.
  const [liveSession, setLiveSession] = useState(false);
  const liveSessionRef = useRef(false);
  const liveIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [threshold, setThreshold] = useState(0.5);
  const [score, setScore] = useState(0);
  const [peak, setPeak] = useState(0); // highest score seen, helps calibration
  const [recordMs, setRecordMs] = useState(DEFAULT_RECORD_MS);
  const [autoSilence, setAutoSilence] = useState(true); // stop when you go quiet
  // TTS voice selection — list of available voices + the chosen one (persisted).
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState("");
  const voiceURIRef = useRef("");
  const [speechRate, setSpeechRate] = useState(1.05);
  const speechRateRef = useRef(1.05);
  const [speaking, setSpeaking] = useState(false); // TTS is currently talking
  const [maxWords, setMaxWords] = useState(20); // spoken-reply word cap
  const maxWordsRef = useRef(20);
  const [useSnapshot, setUseSnapshot] = useState(true); // attach data context
  const useSnapshotRef = useRef(true);
  // True while the controlled (Playwright) browser is open. Set on a successful
  // snapshot, cleared when one reports the browser is closed. Sent to /api/voice
  // so a free-form request ("what's my usage report") routes to the page planner
  // even without a click/type keyword (cloud de-keyword path).
  const browserOpenRef = useRef(false);
  const thresholdRef = useRef(0.5);
  const recordMsRef = useRef(DEFAULT_RECORD_MS);
  const autoSilenceRef = useRef(true);
  const cancelledRef = useRef(false); // set when the user cancels a capture
  const abortRef = useRef<AbortController | null>(null); // aborts the in-flight request
  const ttsHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null); // keeps Chrome TTS alive
  const silenceCtxRef = useRef<AudioContext | null>(null);
  const silenceRafRef = useRef<number | null>(null);
  // Pending local action (e.g. open Spotify) awaiting the user's spoken or
  // tapped confirmation before we forward it to the local bridge.
  const [pendingAction, setPendingAction] = useState<LocalActionIntent | null>(
    null
  );
  const pendingActionRef = useRef<LocalActionIntent | null>(null);
  // Pending controlled-browser ACTION (a planned click/type/scroll from the
  // bridge snapshot) awaiting the user's spoken/tapped confirmation.
  type BrowserPlan = { act: string; ref: number | null; text: string | null; say: string };
  const [pendingBrowser, setPendingBrowser] = useState<BrowserPlan | null>(null);
  const pendingBrowserRef = useRef<BrowserPlan | null>(null);
  // The original free-form browser instruction, kept across confirmed steps so
  // the client can re-plan on the fresh page (multi-step: click → re-snapshot →
  // read). Cleared when the task finishes. `browserStepsRef` caps the loop.
  const browserInstructionRef = useRef<string | null>(null);
  const browserStepsRef = useRef(0);
  // Autonomous browser mode (LOCAL/Hermes path): JARVIS's native browser tools are
  // the browser capability, so the loop chains open→snapshot→read→click… WITHOUT a
  // per-step confirm until it has the answer or hits the cap.
  const autonomousBrowserRef = useRef(false);
  const MAX_BROWSER_STEPS = 6;
  // Developer mode: a proposed PowerShell command awaiting the user's TYPED
  // confirmation (a tap on the literal command), never a spoken yes/no.
  const [pendingShell, setPendingShell] = useState<{
    command: string;
    label: string;
  } | null>(null);
  const [shellRunning, setShellRunning] = useState(false);
  const [shellOutput, setShellOutput] = useState<string | null>(null);
  const [showBridge, setShowBridge] = useState(false);
  const [bridgeUrl, setBridgeUrl] = useState("");
  const [bridgeTok, setBridgeTok] = useState("");
  const [bridgeOk, setBridgeOk] = useState<boolean | null>(null);
  const [shellEnabled, setShellEnabled] = useState<boolean | null>(null);
  const [devBusy, setDevBusy] = useState(false);
  const [userProfile, setUserProfileState] = useState("");
  const [relaySecret, setRelaySecretState] = useState("");
  const [relayOnline, setRelayOnline] = useState<boolean | null>(null);
  // Auto-start / restart controls on the Cloud relay card.
  const [bridgeBusy, setBridgeBusy] = useState<null | "autostart" | "restart">(null);
  const [bridgeMsg, setBridgeMsg] = useState("");

  // Local-computer presence (bridge / Ollama), polled. Used to route a
  // turn to a local backend when the user picked local/hybrid mode. Mirrored to a
  // ref so async capture callbacks read the latest value, not a stale closure.
  const { status: presence } = useLocalPresence();
  const presenceRef = useRef(presence);
  useEffect(() => {
    presenceRef.current = presence;
    // On the phone (no localhost Test), seed the developer-mode indicator from
    // what the laptop reports through the relay, so the toggle shows real state.
    if (bridgeOk !== true && presence.bridge) setShellEnabled(presence.shellEnabled);
  }, [presence]);

  // Phones can't reach the laptop's localhost, so the BRIDGE URL/TOKEN fields are
  // meaningless there — hide them and drive the laptop through the cloud relay.
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Native toolset picker (LOCAL AI panel): which capability groups JARVIS may
  // use. Stored client-side; sent with every turn so disabled groups stay out of
  // the model schema even when a local failure falls back to cloud.
  const [toolsOpen, setToolsOpen] = useState(false);
  // Which control card is open as a centered popup (null = none).
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [disabledGroups, setDisabledGroups] = useState<Set<string>>(new Set());
  useEffect(() => {
    setDisabledGroups(getDisabledGroups());
    void syncToolSchema();
  }, []);
  const syncToolSchema = async () => {
    try {
      await fetch("/api/agent/tool-schema", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledTools: getEnabledLocalToolNames() }),
      });
    } catch {
      /* best-effort; prep also rewrites it on the next turn */
    }
  };
  const toggleGroup = (key: string, enabled: boolean) => {
    setGroupEnabled(key, enabled);
    setDisabledGroups(getDisabledGroups());
    void syncToolSchema();
  };
  const enabledGroupCount = LOCAL_TOOL_GROUPS.filter((g) => !disabledGroups.has(g.key)).length;

  const recorderRef = useRef<PcmRecorder | null>(null);
  const statusRef = useRef<Status>("idle");
  const engineRef = useRef<WakeWordEngine | null>(null);
  const listeningRef = useRef(false);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureModeRef = useRef<"command" | "confirm">("command");
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  // Best-effort screen wake lock so the device is less likely to sleep while
  // Jarvis is listening. Auto-released by the browser when the tab is hidden,
  // so we re-acquire on visibility. Not supported everywhere — fail silently.
  async function acquireWakeLock() {
    try {
      const wl = (navigator as unknown as {
        wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> };
      }).wakeLock;
      if (wl && !document.hidden) wakeLockRef.current = await wl.request("screen");
    } catch {
      /* wake lock unavailable — ignore */
    }
  }

  const setStatusBoth = (s: Status) => {
    statusRef.current = s;
    setStatus(s);
  };

  // Warm up TTS voices so the first reply isn't silent, and populate the picker.
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const saved = localStorage.getItem("tts.voice") || "";
    setVoiceURI(saved);
    voiceURIRef.current = saved;
    // Pre-download/init a saved Piper voice so the first reply plays promptly.
    if (isPiperVoiceURI(saved)) {
      try { void getPiperEngine(piperVoiceId(saved)).prewarm(); } catch { /* ignore */ }
    }
    const savedRate = parseFloat(localStorage.getItem("tts.rate") || "");
    if (Number.isFinite(savedRate)) {
      setSpeechRate(savedRate);
      speechRateRef.current = savedRate;
    }
    const savedMax = parseInt(localStorage.getItem("reply.maxWords") || "", 10);
    if (Number.isFinite(savedMax) && savedMax > 0) {
      setMaxWords(savedMax);
      maxWordsRef.current = savedMax;
    }
    const savedSnap = localStorage.getItem("agent.snapshot");
    if (savedSnap === "false") {
      setUseSnapshot(false);
      useSnapshotRef.current = false;
    }
    const load = () => {
      const list = window.speechSynthesis.getVoices();
      // Prefer English voices first, but keep the rest available too.
      const sorted = [...list].sort((a, b) => {
        const ae = a.lang?.toLowerCase().startsWith("en") ? 0 : 1;
        const be = b.lang?.toLowerCase().startsWith("en") ? 0 : 1;
        return ae - be || a.name.localeCompare(b.name);
      });
      setVoices(sorted);
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () =>
      window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  // Auto-start wake-word listening on load. Keep every mic stream on the raw path
  // so Chrome/Windows do not switch other playback into communications processing.
  useEffect(() => {
    void startListening();
    const onGesture = () => {
      if (!listeningRef.current) void startListening();
    };
    document.addEventListener("pointerdown", onGesture);
    document.addEventListener("keydown", onGesture);

    // Keep listening when the tab is backgrounded (the wake engine runs on the
    // audio thread, so it survives). Just nudge the audio context if the
    // browser suspended it, and restart if it actually died when we return.
    const onVisibility = async () => {
      if (document.hidden) {
        await engineRef.current?.ensureRunning();
      } else {
        if (listeningRef.current) {
          const ok = await engineRef.current?.ensureRunning();
          if (!ok) {
            stopListening();
            void startListening();
          }
        } else {
          void startListening();
        }
        void acquireWakeLock();
      }
    };
    const onUnload = () => engineRef.current?.stop();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("pointerdown", onGesture);
      document.removeEventListener("keydown", onGesture);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onUnload);
      stopSilenceDetection();
      void wakeLockRef.current?.release().catch(() => {});
      engineRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Warm up the LLM so the FIRST command isn't slow: a tiny ping that wakes the
  // serverless function and primes the prompt cache (see /api/voice `warm`). We
  // re-warm whenever the active model changes (a daily-limit rotation), so the
  // newly-active model is primed too — tracked by warmedModelRef.
  const warmedModelRef = useRef<string>("");
  // Timestamp of the last REAL turn — a genuine request already wakes the function
  // + TLS, so the keep-alive below skips pinging when one just ran.
  const lastTurnAtRef = useRef<number>(0);
  const warmUp = async () => {
    try {
      await fetch("/api/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warm: true }),
      });
    } catch {
      /* a cold first request is the only cost */
    }
  };

  // Warm the LLM on mount.
  useEffect(() => {
    void warmUp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep-alive cadence: Vercel functions (and the open TLS connection to the
  // provider) go cold after a few idle minutes, so the NEXT turn pays a cold
  // start. While the tab is visible, re-warm on a ~4-minute cadence — but only
  // when idle: a real turn within the window already warmed the path, and we
  // never ping while hidden (no upcoming turn) to avoid burning pings in the
  // background. 4 min stays under typical idle-shutdown windows.
  useEffect(() => {
    const WARM_EVERY_MS = 4 * 60_000;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      // Skip if a real turn ran recently — it already woke the function.
      if (Date.now() - lastTurnAtRef.current < WARM_EVERY_MS) return;
      void warmUp();
    }, WARM_EVERY_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Speak `text`. `onEnd` (if given) fires when the utterance finishes — used by
  // the confirm flow so we only open the mic AFTER the prompt stops playing, or
  // the mic would record the prompt itself ("…say yes or no") and mis-hear it.
  function speak(text: string, onEnd?: () => void) {
    const clearHeartbeat = () => {
      if (ttsHeartbeatRef.current) {
        clearInterval(ttsHeartbeatRef.current);
        ttsHeartbeatRef.current = null;
      }
    };
    try {
      // Piper neural voice selected → synthesize + play locally instead of the
      // OS speechSynthesis path.
      if (isPiperVoiceURI(voiceURIRef.current)) {
        clearHeartbeat();
        if (!text) {
          setSpeaking(false);
          onEnd?.();
          return;
        }
        const engine = getPiperEngine(piperVoiceId(voiceURIRef.current));
        engine.onSpeakingChange(setSpeaking);
        engine.speak(text, speechRateRef.current || 1, {
          onEnd: () => {
            setSpeaking(false);
            onEnd?.();
          },
        });
        return;
      }
      const synth = window.speechSynthesis;
      if (!synth || !text) {
        setSpeaking(false);
        onEnd?.();
        return;
      }
      clearHeartbeat();
      synth.cancel(); // clear any stuck/previous utterance first
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      u.rate = speechRateRef.current || 1.05;
      const all = synth.getVoices();
      // Use the user's chosen voice if set; else the first English voice.
      const chosen =
        all.find((v) => v.voiceURI === voiceURIRef.current) ||
        all.find((v) => v.lang?.toLowerCase().startsWith("en"));
      if (chosen) {
        u.voice = chosen;
        u.lang = chosen.lang;
      }
      u.onstart = () => setSpeaking(true);
      const done = () => {
        setSpeaking(false);
        clearHeartbeat();
        onEnd?.();
      };
      u.onend = done;
      u.onerror = done; // don't strand the flow if TTS errors
      // Defer the speak to the NEXT tick: calling speak() in the same tick as
      // cancel() is the documented Chrome bug where the utterance is silently
      // dropped (the "sometimes it doesn't talk back" symptom). The small delay
      // lets cancel() settle so the new utterance actually starts.
      setTimeout(() => {
        try {
          synth.resume();
          synth.speak(u);
          // Chrome silently pauses synthesis after ~15s; nudge it while speaking
          // so longer replies don't cut off, and stop nudging once it's done.
          clearHeartbeat();
          ttsHeartbeatRef.current = setInterval(() => {
            if (synth.speaking) synth.resume();
            else clearHeartbeat();
          }, 8000);
        } catch {
          done();
        }
      }, 60);
    } catch {
      setSpeaking(false);
      clearHeartbeat();
      onEnd?.(); // TTS unavailable — proceed immediately so the flow continues
    }
  }

  // A streaming speaker: push sentences as they arrive and they're QUEUED into
  // speechSynthesis (which plays utterances back-to-back), so a long read starts
  // talking on the first sentence instead of waiting for the whole text. Call
  // finish() once the source stream ends; onAllDone fires after the queue drains.
  function makeStreamSpeaker(onAllDone: () => void) {
    // Piper neural voice selected → stream sentences through the local engine.
    if (isPiperVoiceURI(voiceURIRef.current)) {
      const engine = getPiperEngine(piperVoiceId(voiceURIRef.current));
      engine.onSpeakingChange(setSpeaking);
      const stream = engine.makeStream(speechRateRef.current || 1, {
        onEnd: () => {
          setSpeaking(false);
          onAllDone();
        },
      });
      return { push: stream.push, finish: stream.finish };
    }
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    let enqueued = 0;
    let ended = 0;
    let streamDone = false;
    let started = false;
    let finished = false;
    const clearHeartbeat = () => {
      if (ttsHeartbeatRef.current) {
        clearInterval(ttsHeartbeatRef.current);
        ttsHeartbeatRef.current = null;
      }
    };
    const finalize = () => {
      if (finished) return;
      finished = true;
      clearHeartbeat();
      setSpeaking(false);
      onAllDone();
    };
    const maybeFinish = () => {
      if (streamDone && ended >= enqueued) finalize();
    };
    if (!synth) {
      // No TTS — degrade to "speak nothing, just finish when the stream ends".
      return {
        push: (_: string) => {},
        finish: () => finalize(),
      };
    }
    return {
      push(sentence: string) {
        if (!sentence.trim()) return;
        if (!started) {
          started = true;
          synth.cancel(); // clear any prior utterance once, before the first chunk
        }
        const u = new SpeechSynthesisUtterance(sentence);
        u.lang = "en-US";
        u.rate = speechRateRef.current || 1.05;
        const all = synth.getVoices();
        const chosen =
          all.find((v) => v.voiceURI === voiceURIRef.current) ||
          all.find((v) => v.lang?.toLowerCase().startsWith("en"));
        if (chosen) {
          u.voice = chosen;
          u.lang = chosen.lang;
        }
        u.onstart = () => setSpeaking(true);
        const done = () => {
          ended++;
          maybeFinish();
        };
        u.onend = done;
        u.onerror = done;
        enqueued++;
        // Small defer on the FIRST utterance only (the Chrome cancel()->speak()
        // same-tick drop bug); subsequent ones queue immediately.
        const fire = () => {
          try {
            synth.resume();
            synth.speak(u);
            if (!ttsHeartbeatRef.current) {
              ttsHeartbeatRef.current = setInterval(() => {
                if (synth.speaking) synth.resume();
                else clearHeartbeat();
              }, 8000);
            }
          } catch {
            done();
          }
        };
        if (enqueued === 1) setTimeout(fire, 60);
        else fire();
      },
      finish() {
        streamDone = true;
        if (enqueued === 0) finalize();
        else maybeFinish();
      },
    };
  }

  // Immediately silence Jarvis (cancel any queued/active TTS).
  function stopSpeaking() {
    if (ttsHeartbeatRef.current) {
      clearInterval(ttsHeartbeatRef.current);
      ttsHeartbeatRef.current = null;
    }
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    if (isPiperVoiceURI(voiceURIRef.current)) {
      try {
        getPiperEngine(piperVoiceId(voiceURIRef.current)).stop();
      } catch {
        /* ignore */
      }
    }
    setSpeaking(false);
  }

  function stopSilenceDetection() {
    if (silenceRafRef.current != null) {
      cancelAnimationFrame(silenceRafRef.current);
      silenceRafRef.current = null;
    }
    silenceCtxRef.current?.close().catch(() => {});
    silenceCtxRef.current = null;
  }

  // Watch the recording stream's volume and auto-stop ~1.2s after the user
  // stops talking (but only once they've actually said something).
  function startSilenceDetection(stream: MediaStream) {
    const SPEECH_RMS = 0.02; // above this counts as speech
    const SILENCE_HANG_MS = 1300; // quiet for this long after speech => stop
    const MIN_MS = 600; // ignore the first moments (avoid instant stop)
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const actx = new Ctx();
      silenceCtxRef.current = actx;
      const src = actx.createMediaStreamSource(stream);
      const analyser = actx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const startedAt = performance.now();
      let hasSpoken = false;
      let lastLoud = startedAt;

      const tick = () => {
        if (statusRef.current !== "recording") return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const now = performance.now();
        if (rms > SPEECH_RMS) {
          // First sign of speech in a live turn: cancel the no-speech idle timer
          // so a long answer isn't mistaken for an empty room.
          if (!hasSpoken && liveIdleRef.current) {
            clearTimeout(liveIdleRef.current);
            liveIdleRef.current = null;
          }
          hasSpoken = true;
          lastLoud = now;
        }
        if (
          hasSpoken &&
          now - startedAt > MIN_MS &&
          now - lastLoud > SILENCE_HANG_MS
        ) {
          stopRecording(); // sends the captured audio
          return;
        }
        silenceRafRef.current = requestAnimationFrame(tick);
      };
      silenceRafRef.current = requestAnimationFrame(tick);
    } catch {
      /* no analyser — fall back to the fixed timer */
    }
  }

  async function startRecording(auto = false) {
    if (statusRef.current !== "idle") return;
    try {
      // Keep command capture on the same raw audio path as wake-word listening.
      // Enabling echoCancellation/noiseSuppression/autoGainControl can make
      // Chrome/Windows duck or muffle music while Jarvis is recording.
      const shared = engineRef.current?.micStream ?? null;
      let stream: MediaStream;
      let ownStream = false;
      if (shared && shared.getAudioTracks().some((t) => t.readyState === "live")) {
        stream = shared;
      } else {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          });
          ownStream = true;
        } catch {
          throw new Error("no mic");
        }
      }
      // Capture the command as raw PCM off an AudioContext (the SAME clean path
      // wake-word listening uses) instead of MediaRecorder. MediaRecorder on a
      // mic forces Chrome's WebRTC capture pipeline on, which pushes Windows into
      // "communications" mode and ducks/muffles music for the whole recording.
      // ScriptProcessor capture doesn't, so music stays full-quality.
      const rec = new PcmRecorder(stream);
      rec.onstop = () => {
        stopSilenceDetection();
        if (ownStream) stream.getTracks().forEach((t) => t.stop());
        // User cancelled this capture — discard, don't transcribe.
        if (cancelledRef.current) {
          cancelledRef.current = false;
          rec.dispose();
          setStatusBoth("idle");
          engineRef.current?.resume();
          return;
        }
        const blob = rec.toWavBlob();
        if (captureModeRef.current === "confirm") {
          captureModeRef.current = "command";
          void sendConfirmAudio(blob);
          return;
        }
        if (blob.size < 1200) {
          setStatusBoth("idle");
          if (liveSessionRef.current) {
            continueLiveSession(); // keep listening for the next thing they say
          } else {
            setReply("That was too short — hold the button while you speak.");
            engineRef.current?.resume();
          }
          return;
        }
        void sendAudio(blob);
      };
      recorderRef.current = rec;
      cancelledRef.current = false;
      // No timeslice: record into ONE blob flushed on stop. Slicing into 250ms
      // chunks and concatenating can yield a container Groq's Whisper can't
      // decode ("could not process file") — a single segment is always valid.
      rec.start();
      setStatusBoth("recording");
      setTranscript("");
      if (captureModeRef.current !== "confirm") {
        setReply(
          liveSessionRef.current
            ? "Listening…"
            : auto
            ? "Heard “Jarvis” — listening…"
            : ""
        );
      }
      // Live turns end on your pause (silence detection is forced on) and don't
      // use the hard window cap; instead a no-speech idle timer ends the session.
      // Wake-triggered captures stop on silence (if enabled) and always have a
      // hard cap from the listen-window slider so they can't run forever.
      if (auto) {
        if (liveSessionRef.current) {
          startSilenceDetection(stream);
          if (liveIdleRef.current) clearTimeout(liveIdleRef.current);
          liveIdleRef.current = setTimeout(() => {
            if (liveSessionRef.current)
              exitLiveSession("No one's talking — ending live conversation.");
          }, LIVE_IDLE_MS);
        } else {
          if (autoSilenceRef.current) startSilenceDetection(stream);
          autoStopRef.current = setTimeout(stopRecording, recordMsRef.current);
        }
      }
    } catch {
      setReply("Microphone access denied.");
      engineRef.current?.resume();
    }
  }

  function stopRecording() {
    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
    if (liveIdleRef.current) {
      clearTimeout(liveIdleRef.current);
      liveIdleRef.current = null;
    }
    if (statusRef.current !== "recording") return;
    recorderRef.current?.stop();
    setStatusBoth("thinking");
  }

  // Abort the current capture or in-flight request and go back to listening.
  function cancel() {
    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
    if (statusRef.current === "recording") {
      cancelledRef.current = true; // tell onstop to discard
      recorderRef.current?.stop();
    } else if (statusRef.current === "thinking") {
      abortRef.current?.abort();
      setStatusBoth("idle");
      engineRef.current?.resume();
    }
    setReply("Cancelled.");
    setTranscript("");
    // A cancel during a live session is the user's escape hatch — end it.
    if (liveSessionRef.current) exitLiveSession("Live conversation off.");
  }

  // Transcribe a clip on its own (no agent) — used by the local-mode path, where
  // we need the text before deciding which local backend runs the turn.
  async function transcribeBlob(blob: Blob): Promise<string> {
    try {
      const form = new FormData();
      form.append("audio", blob, "speech.webm");
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const data = await res.json();
      return (data.transcript || "").trim();
    } catch {
      return "";
    }
  }

  // If the bridge is online, route this turn to the LOCAL backend and hand the
  // result to the shared handler. Returns false only when no bridge is found, so
  // the caller uses the cloud path.
  async function dispatchLocal(text: string): Promise<boolean> {
    const backend = decideTurnRoute(getModelMode(), text, presenceRef.current);
    if (backend === "cloud") return false;
    // FULLY MODEL-DRIVEN: no deterministic browser-intent pre-check. The local
    // native tool loop is handed the enabled tool schema (including the agentic
    // browser_* tools when that group is on) and decides for itself whether to
    // open/snapshot/act on the controlled browser — same as every other tool.
    autonomousBrowserRef.current = true; // browser tools the model calls run without per-step confirms
    setStatusBoth("thinking");
    // Local turn = JARVIS's own native tool loop, inference via the /api/v1 router.
    markThinking("jarvis", "JARVIS (local) thinking…");
    logRoute("jarvis", "▸ local turn → JARVIS native tools (/api/v1)");
    const resp = await runLocalTurn(text, presenceRef.current, {
      userProfile: getUserProfile(),
      useSnapshot: useSnapshotRef.current,
      maxWords: maxWordsRef.current,
    });
    // NO cloud fallback: local and cloud hit the SAME rotating /api/v1 keys, so a
    // failure (rate-limited, router down) would just fail the same way on cloud —
    // and switching paths would wrongly hand the model a different (all-tools)
    // schema. Surface the error here and stay on the local path.
    if (resp.error) {
      console.warn("[JARVIS] local turn failed:", resp.error);
      logRoute("jarvis", `local turn failed: ${resp.error}`);
    }
    processAgentResponse(resp);
    return true; // handled either way — never fall back to cloud
  }

  // Run a turn on the CLOUD (text → /api/voice JSON), sharing the response
  // handling. Used directly and as the fallback when a local Hermes turn fails.
  async function runCloudText(text: string) {
    const controller = new AbortController();
    abortRef.current = controller;
    markThinking("jarvis");
    const res = await fetch("/api/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        userProfile: getUserProfile(),
        maxWords: maxWordsRef.current,
        useSnapshot: useSnapshotRef.current,
        browserOpen: browserOpenRef.current,
        // Cloud turn: withhold bridge-only tools when no laptop is connected.
        enabledTools: getEnabledLocalToolNames({ bridgeAvailable: presenceRef.current.bridge }),
        // Lets server-side tools that need the computer (WhatsApp send) refuse
        // cleanly and prefer Telegram/email when no laptop is connected.
        bridgeAvailable: presenceRef.current.bridge,
      }),
      signal: controller.signal,
    });
    const data = await res.json();
    processAgentResponse(data);
  }

  async function sendAudio(blob: Blob) {
    try {
      // Local computer online: transcribe, then run the turn on the user's
      // machine (the cloud STT is still used — Whisper is cloud).
      const p = presenceRef.current;
      if (p.bridge) {
        const text = await transcribeBlob(blob);
        if (!text) {
          setReply("I didn't catch that.");
          setStatusBoth("idle");
          engineRef.current?.resume();
          if (liveSessionRef.current) continueLiveSession();
          return;
        }
        setTranscript(text);
        // If the local turn handled it, we're done; otherwise fall through to
        // the cloud path with the already-transcribed text.
        if (await dispatchLocal(text)) return;
        await runCloudText(text);
        return;
      }
      const ext = blob.type.includes("wav")
        ? "wav"
        : blob.type.includes("mp4")
        ? "mp4"
        : blob.type.includes("ogg")
        ? "ogg"
        : "webm";
      const form = new FormData();
      form.append("audio", blob, `speech.${ext}`);
      const profile = getUserProfile();
      if (profile) form.append("userProfile", profile);
      form.append("maxWords", String(maxWordsRef.current));
      form.append("useSnapshot", String(useSnapshotRef.current));
      form.append("browserOpen", String(browserOpenRef.current));
      form.append("enabledTools", JSON.stringify(getEnabledLocalToolNames({ bridgeAvailable: presenceRef.current.bridge })));
      form.append("bridgeAvailable", String(presenceRef.current.bridge));
      const controller = new AbortController();
      abortRef.current = controller;
      markThinking("jarvis");
      const res = await fetch("/api/voice", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const data = await res.json();
      processAgentResponse(data);
    } catch (err: any) {
      // Aborted by the user — cancel() already updated the UI, so leave it.
      if (err?.name === "AbortError") return;
      setReply("Something went wrong.");
    } finally {
      abortRef.current = null;
      // Don't clobber the confirmation flow if it took over.
      if (statusRef.current === "thinking") {
        setStatusBoth("idle");
        engineRef.current?.resume(); // resume wake detection after the command
      }
    }
  }

  // Shared handling of the /api/voice response (used by both voice and typed
  // input). Returns true if a confirmation flow (shell/local action) took over.
  function processAgentResponse(data: any): boolean {
    // Browser-console trace for testing: what routed, and which tools ran.
    try {
      const r = data.routing;
      const head = r
        ? `${r.multi ? "MULTI" : "single"}${r.slim ? " · slim" : ""} → sent [${(r.tools || []).join(", ")}]${r.trigger ? ` · trigger "${r.trigger}"` : ""}`
        : "CHAT — no keyword matched (no tools)";
      console.log(
        `%c[JARVIS] "${data.transcript || ""}"%c\n  route: ${head}`,
        "color:#22d3ee;font-weight:bold",
        "color:inherit"
      );
      const acts = (data.actions || []) as { name: string; args: unknown; result: unknown }[];
      if (acts.length) {
        for (const a of acts) console.log(`  ▸ ran ${a.name}`, a.args, "→", a.result);
      } else {
        console.log("  ▸ no tools ran");
      }
      if (data.usage?.total) console.log(`  ▸ ${data.usage.total} tokens`);
    } catch {
      /* logging is best-effort */
    }

    if (data.transcript) setTranscript(data.transcript);
    const utter = (data.transcript || "").toLowerCase();
    // Voice control of live mode: end it if the user said an exit phrase, or
    // (re)enter it if they asked to — handled before we speak/continue below.
    if (liveSessionRef.current && LIVE_EXIT_RE.test(utter)) {
      setReply(data.reply || "");
      onDone();
      exitLiveSession();
      return false;
    }
    if (!liveSessionRef.current && LIVE_ENTER_RE.test(utter)) {
      enterLiveSession(false); // flag on; the reply below keeps the loop going
    }
    setReply(data.reply || data.error || "");
    if (data.model) {
      // Mirror the model that answered into the floating HUD (visible from any
      // tab), with the chain + which models were daily-exhausted this turn.
      const out = (data.exhausted || []) as string[];
      // A real turn just ran — it woke the function + TLS, so the keep-alive
      // interval can skip its next ping.
      lastTurnAtRef.current = Date.now();
      const detail = data.usage?.total ? `${data.usage.total} tok` : "answered";
      publishModel("jarvis", data.model, detail, false);
      if (out.length) logRoute("jarvis", `out today: ${out.join(", ")}`);
      // If the active model rotated (e.g. the previous one hit its daily limit),
      // re-warm so the now-active model + its next fallback are primed for the
      // following request — keeps it fast even after a rotation.
      // Only re-warm cloud models; a local turn (model "local:…") never uses the
      // cloud warm-up path.
      if (
        data.model !== warmedModelRef.current &&
        !/^local:/.test(data.model)
      ) {
        warmedModelRef.current = data.model;
        void warmUp();
      }
    }
    onDone();

    // Route the user to the relevant tab based on what JARVIS just did
    // (e.g. created a task → Tasks, read email → Inbox).
    const navTab = pickTabFromActions(data.actions);
    if (navTab) {
      window.dispatchEvent(new CustomEvent("jarvis-nav", { detail: navTab }));
    }

    // A confirm flow (shell / local action) opens its own mic, so the live loop
    // must NOT also restart listening — it resumes after the confirm finishes.
    const shell = findShellAction(data.actions);
    const intent = shell ? null : findLocalAction(data.actions);
    // A controlled-browser command: the client drives the bridge and speaks its
    // own progress, so take over BEFORE speaking the neutral server reply.
    const browser = shell || intent ? null : findBrowserAction(data.actions);
    if (browser) {
      void handleBrowserAction(browser);
      return true;
    }
    const willConfirm = !!(shell || intent);

    // Speak the reply. In a live session, chain straight back into listening
    // once Jarvis stops talking (unless a confirm flow is taking over).
    const loopAfter = liveSessionRef.current && !willConfirm;
    if (data.reply) {
      speak(data.reply, loopAfter ? continueLiveSession : undefined);
    } else if (loopAfter) {
      continueLiveSession();
    }

    // Developer mode: a shell command needs a TYPED confirmation, its own flow.
    if (shell) {
      startShellConfirmation(shell);
      return true;
    }
    // A local action (e.g. open Spotify) needs the confirm flow.
    if (intent) {
      startConfirmation(intent);
      return true;
    }
    return false;
  }

  // Send a TYPED command (skips speech-to-text for accuracy). Reuses the same
  // agent + response handling as voice.
  async function sendText(text: string) {
    const q = text.trim();
    const busy = statusRef.current === "thinking";
    if (!q || busy) return;
    engineRef.current?.pause(); // don't let the wake word fire mid-request
    setTranscript(q);
    setReply("");
    setStatusBoth("thinking");
    try {
      // Local/hybrid mode may run this turn on the user's machine instead.
      if (await dispatchLocal(q)) return;
      await runCloudText(q);
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      setReply("Something went wrong.");
    } finally {
      abortRef.current = null;
      if (statusRef.current === "thinking") {
        setStatusBoth("idle");
        engineRef.current?.resume();
      }
    }
  }

  // Pull an open_local_app intent out of the agent's action results, if any.
  function findLocalAction(
    actions: { name: string; result: any }[] | undefined
  ): LocalActionIntent | null {
    if (!actions) return null;
    for (const a of actions) {
      const r = a.result;
      if (
        r &&
        (r.local_action === "open" ||
          r.local_action === "open_app" ||
          r.local_action === "whatsapp_send" ||
          r.local_action === "shutdown") &&
        r.target
      ) {
        return {
          local_action: r.local_action,
          target: r.target,
          label: r.label || r.target,
          ...(r.autoSend ? { autoSend: true } : {}),
          ...(r.cancel ? { cancel: true } : {}),
          ...(r.delaySec != null ? { delaySec: r.delaySec } : {}),
        };
      }
    }
    return null;
  }

  // Phrase the confirm/run wording per action: WhatsApp "sends", the rest "open".
  function actionVerb(intent: LocalActionIntent): { ask: string; doing: string } {
    if (intent.local_action === "whatsapp_send")
      return { ask: "send", doing: "Sending" };
    // shutdown's label is already a full phrase ("shut down your computer in 60
    // seconds" / "cancel the shutdown"), so no leading verb is needed.
    if (intent.local_action === "shutdown") return { ask: "", doing: "Okay —" };
    return { ask: "open", doing: "Opening" };
  }

  // Pull a run_shell intent out of the agent's action results, if any.
  function findShellAction(
    actions: { name: string; result: any }[] | undefined
  ): { command: string; label: string } | null {
    if (!actions) return null;
    for (const a of actions) {
      const r = a.result;
      if (r && r.local_action === "run_shell" && r.command) {
        return { command: String(r.command), label: r.label || r.command };
      }
    }
    return null;
  }

  // ── Controlled-browser actions (Phase 2, via the bridge) ───────────────────
  type BrowserAction = {
    kind: "open" | "read" | "act" | "macro";
    url?: string;
    mode?: "summarize" | "read";
    instruction?: string;
    actions?: string[]; // macro: a sequence of actions run in order
    label: string;
  };
  function findBrowserAction(
    actions: { name: string; result: any }[] | undefined
  ): BrowserAction | null {
    if (!actions) return null;
    for (const a of actions) {
      const r = a.result;
      if (r && r.local_action === "browser" && r.browser_kind) {
        return {
          kind: r.browser_kind,
          url: r.url,
          mode: r.mode,
          instruction: r.instruction,
          actions: Array.isArray(r.actions) ? r.actions : undefined,
          label: r.label || "",
        };
      }
    }
    return null;
  }

  // Track whether the controlled browser is open, from a snapshot result, so the
  // cloud de-keyword path knows to route free-form requests to the page planner.
  function noteSnapshot(r: { ok?: boolean }) {
    browserOpenRef.current = !!r?.ok;
  }

  // Ask the planner for ONE action against the current page's element tree.
  async function planFor(instruction: string): Promise<BrowserPlan | { error: string }> {
    const snap = await pageSnapshot();
    noteSnapshot(snap);
    if (!snap.ok || !snap.tree) {
      return { error: snap.error || "The Jarvis browser is off — say “open <site> in the browser” first (and make sure the bridge is running)." };
    }
    try {
      const res = await fetch("/api/page/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction, tree: snap.tree, title: snap.title }),
      });
      const data = await res.json();
      return data.plan || { error: data.error || "I couldn't plan that." };
    } catch {
      return { error: "I couldn't reach the planner." };
    }
  }

  // Run an instruction automatically — plan one action and do it, no confirm.
  // Used for pre-authorized steps (startup commands + macro sequences). Best-effort:
  // a step that can't be planned is skipped rather than aborting the sequence.
  async function runActionAuto(instruction: string) {
    const plan = await planFor(instruction);
    if ("error" in plan || plan.act === "none") return;
    if (plan.act === "scroll_down" || plan.act === "scroll_up") {
      await pageScroll(plan.act === "scroll_up" ? "up" : "down");
      return;
    }
    await pageAct(plan.act as any, plan.ref ?? undefined, plan.text ?? undefined);
  }

  // Read/summarize the CURRENT page; returns the spoken text (does NOT finish).
  async function readCurrentToText(mode: "summarize" | "read"): Promise<string> {
    const t = await pageText();
    if (!t.ok || !t.content) return t.error || "I couldn't read that page.";
    try {
      const res = await fetch("/api/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: t.content, title: t.title, mode }),
      });
      const data = await res.json();
      return data.reply || data.error || "I couldn't summarize that page.";
    } catch {
      return "I couldn't reach the summarizer.";
    }
  }

  // Read the current page and speak it (single-shot read/summarize), STREAMING the
  // spoken reply so it starts talking on the first sentence. Falls back to the
  // one-shot path if the stream can't be opened.
  async function readCurrentPage(mode: "summarize" | "read", label: string) {
    setReply(`Reading ${label || "the page"}…`);
    setStatusBoth("thinking");
    const t = await pageText();
    if (!t.ok || !t.content) {
      finishBrowser(t.error || "I couldn't read that page.");
      return;
    }
    // End the browser turn WITHOUT speaking (the stream speaker handles speech).
    const finalize = () => {
      pendingBrowserRef.current = null;
      browserInstructionRef.current = null;
      autonomousBrowserRef.current = false;
      setPendingBrowser(null);
      setStatusBoth("idle");
      engineRef.current?.resume();
      continueLiveSession();
    };
    let full = "";
    let speaker: ReturnType<typeof makeStreamSpeaker> | null = null;
    try {
      const res = await fetch("/api/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: t.content, title: t.title, mode, stream: true }),
      });
      if (!res.ok || !res.body) {
        // Stream unavailable — fall back to the one-shot read.
        const data = await res.json().catch(() => ({} as any));
        finishBrowser(data.reply || data.error || "I couldn't summarize that page.");
        return;
      }
      speaker = makeStreamSpeaker(finalize);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj: any;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          if (typeof obj.t === "string") {
            full += obj.t;
            setReply(full);
            speaker.push(obj.t);
          } else if (obj.error && !full) {
            // Errored before any text — surface it the normal way.
            finishBrowser(obj.error);
            return;
          }
        }
      }
      if (!full.trim()) {
        finishBrowser("I couldn't summarize that page.");
        return;
      }
      speaker.finish();
    } catch {
      if (full.trim() && speaker) {
        // We already spoke part of it — drain the queue, then finalize normally.
        speaker.finish();
      } else {
        finishBrowser("I couldn't reach the summarizer.");
      }
    }
  }

  const isReadStep = (s?: string) => !!s && /^(summari[sz]e|read)\b/i.test(s.trim());

  // Drive a free-form browser instruction across as many steps as it takes:
  // plan ONE action on the current page, and either finish (read/done/none/error)
  // or confirm + run it, then re-plan on the fresh page. The original instruction
  // is kept in browserInstructionRef so each re-plan pursues the same goal.
  async function planAndConfirm(instruction: string) {
    browserInstructionRef.current = instruction;
    browserStepsRef.current = 0;
    await stepBrowser();
  }

  // One iteration of the browser loop: snapshot (via planFor) + plan the next
  // action. read/done → answer/finish; a real action → confirm it (the loop
  // continues from runConfirmedBrowser after the user approves).
  async function stepBrowser() {
    const instruction = browserInstructionRef.current;
    if (!instruction) return;
    if (browserStepsRef.current >= MAX_BROWSER_STEPS) {
      browserInstructionRef.current = null;
      finishBrowser("That took more steps than I expected — tell me the next step and I'll continue.");
      return;
    }
    browserStepsRef.current += 1;
    setReply(browserStepsRef.current === 1 ? "One moment…" : "Working on it…");
    setStatusBoth("thinking");
    const plan = await planFor(instruction);
    if ("error" in plan) {
      browserInstructionRef.current = null;
      finishBrowser(plan.error);
      return;
    }
    // The page already has the answer — read it back to satisfy the question.
    if (plan.act === "read") {
      browserInstructionRef.current = null;
      finishBrowser(await readCurrentToText("summarize"));
      return;
    }
    if (plan.act === "done") {
      browserInstructionRef.current = null;
      finishBrowser(plan.say || "Done.");
      return;
    }
    if (plan.act === "none") {
      browserInstructionRef.current = null;
      finishBrowser(plan.say || "I couldn't find that on the page.");
      return;
    }
    // Read-only navigation (just scrolling to bring content into view) is safe to
    // run WITHOUT a confirm — only state-changing actions (click/type/select/check,
    // and back/enter which navigate or submit) ask first.
    if (plan.act === "scroll_down" || plan.act === "scroll_up") {
      setReply(`${plan.say}…`);
      await pageScroll(plan.act === "scroll_up" ? "up" : "down");
      if (browserInstructionRef.current) { await stepBrowser(); return; }
      finishBrowser("Done.");
      return;
    }
    // Autonomous (LOCAL/Hermes) path: JARVIS owns the browser, so run the planned
    // action straight away and keep looping — no per-step confirm.
    if (autonomousBrowserRef.current) {
      await runConfirmedBrowser(plan);
      return;
    }
    startBrowserConfirmation(plan);
  }

  // Open a url in the controlled browser. Returns ok:false (and finishes with an
  // error) if the open failed; otherwise carries the detected login state + host so
  // callers can warn. (Startup steps are no longer auto-run — they live in memory
  // and Jarvis performs them itself as part of the task.)
  async function openPage(
    url?: string,
    label?: string
  ): Promise<{ ok: boolean; login?: LoginState; host?: string }> {
    let login: LoginState | undefined;
    let host: string | undefined;
    if (url) {
      setReply(`Opening ${label || "the page"} in your browser…`);
      const r = await pageSnapshot(url);
      noteSnapshot(r);
      if (!r.ok) {
        // The most common cause is "Playwright session off" — bridge not running
        // or the Jarvis browser not started. Surface that clearly.
        finishBrowser(
          r.error ||
            "I couldn't open that — is the bridge running and the Jarvis browser open? Start it with “npm run bridge”."
        );
        return { ok: false };
      }
      login = r.login;
      host = r.url || url;
    }
    return { ok: true, login, host };
  }

  // Warn about a login the bridge detected. Returns a spoken note to use as the
  // reply, or null if there's nothing to say. Jarvis no longer auto-fills here —
  // when it's signing you in as part of a task it reads your saved login from
  // memory (Abilities → Logins) and types it itself; it NEVER submits, and can't
  // do Google/Apple/SSO. This note just tells you a login is in the way.
  async function maybeHandleLogin(login?: LoginState, urlOrHost?: string): Promise<string | null> {
    if (!login || !login.needed) return null;
    const host = (() => {
      try { return new URL(urlOrHost || "").hostname; } catch { return urlOrHost || "this site"; }
    })();
    const sso = login.providers.length
      ? ` It also offers ${login.providers.join(" / ")} sign-in, which you'll need to do yourself.`
      : "";

    if (login.hasPassword || login.emailOnly) {
      return `${host} needs a login. If you saved it under Abilities → Logins I can sign you in (you review and submit); otherwise sign in yourself in the Jarvis browser.${sso}`;
    }

    const ps = login.providers.length ? login.providers.join(" / ") : "Google/SSO";
    return `Heads up — ${host} uses ${ps} sign-in, which I can't fill for you. Please log in yourself in the Jarvis browser window.`;
  }

  // Drive the bridge's real browser. open/read/macro run straight through (with any
  // configured startup); a single click/type ("act") is planned then confirmed.
  async function handleBrowserAction(b: BrowserAction) {
    engineRef.current?.pause();

    if (b.kind === "open") {
      const o = await openPage(b.url, b.label);
      if (!o.ok) return;
      const note = await maybeHandleLogin(o.login, o.host || b.url);
      finishBrowser(note || `Opened ${b.label || "the page"}.`);
      return;
    }

    if (b.kind === "read") {
      if (b.url) {
        const o = await openPage(b.url, b.label);
        if (!o.ok) return;
        // If the page wants a login, warn instead of reading a login screen aloud.
        const note = await maybeHandleLogin(o.login, o.host || b.url);
        if (note) { finishBrowser(note); return; }
      }
      await readCurrentPage(b.mode || "summarize", b.label);
      return;
    }

    if (b.kind === "macro") {
      if (b.url) {
        const o = await openPage(b.url, b.label);
        if (!o.ok) return;
        const note = await maybeHandleLogin(o.login, o.host || b.url);
        if (note) { finishBrowser(note); return; }
      }
      const steps = (b.actions || []).filter(Boolean);
      if (!steps.length) {
        finishBrowser(`Opened ${b.label || "the page"}.`);
        return;
      }
      // Run every step in order, automatically (the user pre-defined this macro,
      // so no per-step confirm). A read/summarize step's text becomes the spoken
      // reply at the end (the last read wins).
      setStatusBoth("thinking");
      let spoken = "";
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        setReply(`Step ${i + 1} of ${steps.length}: ${step}…`);
        if (isReadStep(step)) {
          spoken = await readCurrentToText(/^read\b/i.test(step.trim()) ? "read" : "summarize");
        } else {
          await runActionAuto(step);
        }
      }
      finishBrowser(spoken || "Done.");
      return;
    }

    // kind === "act"
    await planAndConfirm(b.instruction || "");
  }

  // Ask the user (aloud) to confirm a planned browser action, then listen yes/no.
  function startBrowserConfirmation(plan: BrowserPlan) {
    pendingBrowserRef.current = plan;
    setPendingBrowser(plan);
    setStatusBoth("confirming");
    abortRef.current = null;
    const question = `Do you want me to ${plan.say}? Say yes or no.`;
    setReply(question);
    engineRef.current?.pause();
    let started = false;
    const begin = () => {
      if (started) return;
      started = true;
      setTimeout(() => {
        if (statusRef.current !== "confirming") return;
        captureModeRef.current = "confirm";
        setStatusBoth("idle");
        void startRecording(true);
      }, 350);
    };
    speak(question, begin);
    setTimeout(begin, 7000);
  }

  async function runConfirmedBrowser(plan: BrowserPlan) {
    setReply(`${plan.say}…`);
    const r = await pageAct(plan.act as any, plan.ref ?? undefined, plan.text ?? undefined);
    if (!r.ok) {
      browserInstructionRef.current = null;
      finishBrowser(r.error || "That didn't work.");
      return;
    }
    // The action may have advanced a login flow (e.g. clicking "Continue" after the
    // email step reveals the password field) — re-snapshot and handle/warn if so.
    try {
      const snap = await pageSnapshot();
      noteSnapshot(snap);
      if (snap.ok) {
        const note = await maybeHandleLogin(snap.login, snap.url);
        if (note) { browserInstructionRef.current = null; finishBrowser(note); return; }
      }
    } catch {}
    // Multi-step: if this action was part of a free-form instruction, re-plan on
    // the now-updated page and keep going (click → re-snapshot → read → answer).
    if (browserInstructionRef.current) {
      await stepBrowser();
      return;
    }
    finishBrowser(r.message || "Done.");
  }

  function finishBrowser(message: string) {
    pendingBrowserRef.current = null;
    browserInstructionRef.current = null; // end any multi-step browser loop
    autonomousBrowserRef.current = false; // back to confirm-per-step for cloud turns
    setPendingBrowser(null);
    setReply(message);
    speak(message);
    setStatusBoth("idle");
    engineRef.current?.resume();
    continueLiveSession();
  }

  // Developer mode: present the literal command for a typed confirmation. We do
  // NOT speak the command or listen for "yes" — the whole safety model is the
  // user reading the exact text and tapping Run, so voice is deliberately out.
  function startShellConfirmation(shell: { command: string; label: string }) {
    setShellOutput(null);
    setPendingShell(shell);
    setStatusBoth("confirming");
    abortRef.current = null;
    const msg = `I've prepared a command: ${shell.label}. Review it and tap Run.`;
    setReply(msg);
    speak(msg);
    engineRef.current?.pause(); // don't let "Jarvis" re-trigger mid-review
  }

  async function runPendingShell() {
    const shell = pendingShell;
    if (!shell || shellRunning) return;
    setShellRunning(true);
    setReply(`Running: ${shell.label}…`);
    const res = await runShell(shell.command);
    setShellRunning(false);
    setPendingShell(null);
    setShellOutput(res.output ?? "");
    setReply(res.message);
    speak(res.message);
    setStatusBoth("idle");
    engineRef.current?.resume();
    continueLiveSession();
  }

  function cancelPendingShell() {
    setPendingShell(null);
    setReply("Cancelled.");
    setStatusBoth("idle");
    engineRef.current?.resume();
    continueLiveSession();
  }

  // Ask the user (aloud) to confirm a local action, then listen for yes/no.
  function startConfirmation(intent: LocalActionIntent) {
    pendingActionRef.current = intent;
    setPendingAction(intent);
    setStatusBoth("confirming");
    abortRef.current = null;
    const question = `Do you want me to ${actionVerb(intent).ask} ${intent.label}? Say yes or no.`;
    setReply(question);
    engineRef.current?.pause(); // don't let "Jarvis" re-trigger mid-confirm

    // Open the mic only AFTER the spoken prompt finishes (plus a short tail so the
    // speaker stops ringing), so we capture the user's answer — not the prompt.
    // Idempotent: whichever of onEnd / the safety timer fires first wins.
    let started = false;
    const begin = () => {
      if (started) return;
      started = true;
      // ~350ms tail after speech ends before listening.
      setTimeout(() => {
        if (statusRef.current !== "confirming") return;
        captureModeRef.current = "confirm";
        setStatusBoth("idle"); // startRecording requires idle
        void startRecording(true);
      }, 350);
    };
    speak(question, begin);
    // Safety net in case onend never fires (some browsers): begin anyway.
    setTimeout(begin, 7000);
  }

  // Interpret the spoken yes/no and either run or cancel the pending action.
  async function sendConfirmAudio(blob: Blob) {
    const browserPlan = pendingBrowserRef.current;
    const intent = pendingActionRef.current;
    if (!intent && !browserPlan) {
      setStatusBoth("idle");
      engineRef.current?.resume();
      return;
    }
    setStatusBoth("thinking");
    let said = "";
    try {
      const form = new FormData();
      form.append("audio", blob, "confirm.webm");
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const data = await res.json();
      said = (data.transcript || "").toLowerCase();
    } catch {
      /* treat as no answer */
    }
    // Belt-and-suspenders: if any tail of our own prompt leaked into the capture,
    // strip the known prompt phrasing ("...say yes or no") so its "no" doesn't
    // count as the user's answer.
    const cleaned = said
      .replace(/do you want me to.*?\?/g, " ")
      .replace(/say yes or no\.?/g, " ")
      .replace(/\byes or no\b/g, " ");
    const yes = /\b(yes|yeah|yep|yup|sure|ok|okay|go|go ahead|do it|confirm|please|open|send)\b/.test(
      cleaned
    );
    const no = /\b(no|nope|nah|don'?t|cancel|stop|never)\b/.test(cleaned);
    if (yes && !no) {
      if (browserPlan) await runConfirmedBrowser(browserPlan);
      else if (intent) await runConfirmedAction(intent);
    } else if (browserPlan) {
      finishBrowser("Okay, I won't do that.");
    } else if (intent) {
      const msg = `Okay, I won't ${actionVerb(intent).ask} ${intent.label}.`;
      finishConfirmation(msg);
      speak(msg);
    }
  }

  // Manual fallback buttons (in case the spoken answer is misheard).
  function manualConfirm() {
    const browserPlan = pendingBrowserRef.current;
    const intent = pendingActionRef.current;
    if (!intent && !browserPlan) return;
    if (statusRef.current === "confirming") {
      cancelledRef.current = true; // discard the listening capture, if any
      recorderRef.current?.stop();
    }
    if (browserPlan) void runConfirmedBrowser(browserPlan);
    else if (intent) void runConfirmedAction(intent);
  }

  function manualDeny() {
    const browserPlan = pendingBrowserRef.current;
    const intent = pendingActionRef.current;
    if (statusRef.current === "confirming") {
      cancelledRef.current = true;
      recorderRef.current?.stop();
    }
    if (browserPlan) {
      finishBrowser("Okay, I won't do that.");
      return;
    }
    const msg = intent
      ? `Okay, I won't ${actionVerb(intent).ask} ${intent.label}.`
      : "Cancelled.";
    finishConfirmation(msg);
  }

  async function runConfirmedAction(intent: LocalActionIntent) {
    setReply(`${actionVerb(intent).doing} ${intent.label}…`);
    const result = await runLocalAction(intent);
    finishConfirmation(result.message);
    speak(result.message);
  }

  function finishConfirmation(message: string) {
    pendingActionRef.current = null;
    setPendingAction(null);
    setReply(message);
    setStatusBoth("idle");
    engineRef.current?.resume();
    continueLiveSession(); // resume the loop if we're in a live session
  }

  function handleWake() {
    if (statusRef.current !== "idle") return;
    engineRef.current?.pause(); // don't detect our own command audio
    void startRecording(true);
  }

  // ── Live conversation ──────────────────────────────────────────────────────
  // Turn on continuous mode: pause the wake word and (optionally) greet, then
  // start the listen→reply→listen loop so the user can talk normally.
  function enterLiveSession(greet = true) {
    liveSessionRef.current = true;
    setLiveSession(true);
    engineRef.current?.pause(); // wake word off for the duration of the session
    if (greet) {
      const msg =
        'Live conversation on. I\'m listening — say "that\'s all" when you\'re done.';
      setTranscript("");
      setReply(msg);
      speak(msg, continueLiveSession);
    }
  }

  // End continuous mode and fall back to wake-word listening.
  function exitLiveSession(
    msg = 'Live conversation off. Say "Jarvis" when you need me.'
  ) {
    liveSessionRef.current = false;
    setLiveSession(false);
    if (liveIdleRef.current) {
      clearTimeout(liveIdleRef.current);
      liveIdleRef.current = null;
    }
    if (statusRef.current === "recording") {
      cancelledRef.current = true; // discard any in-progress capture
      recorderRef.current?.stop();
    }
    setStatusBoth("idle");
    setReply(msg);
    speak(msg);
    engineRef.current?.resume(); // back to listening for "Jarvis"
  }

  // Re-open the mic for the next turn of a live session, after Jarvis finishes
  // speaking. Deferred a tick so the request's `finally` can settle to idle.
  function continueLiveSession(attempt = 0) {
    if (!liveSessionRef.current) return;
    setTimeout(() => {
      if (!liveSessionRef.current) return;
      // Only re-open the mic when JARVIS is idle — a live session must listen
      // continuously EXCEPT while it's thinking/recording/speaking. If we're not
      // idle yet (still finishing a turn, a confirm, or speaking), wait and try
      // again instead of giving up, so the loop never silently dies mid-session.
      if (statusRef.current !== "idle") {
        if (attempt < 100) continueLiveSession(attempt + 1); // ~ up to 30s of waiting
        return;
      }
      engineRef.current?.pause();
      captureModeRef.current = "command";
      void startRecording(true);
    }, 300);
  }

  function toggleLiveSession() {
    if (liveSessionRef.current) exitLiveSession();
    else enterLiveSession();
  }

  async function startListening() {
    if (listeningRef.current || wakeBusy) return;
    setWakeBusy(true);
    try {
      const { WakeWordEngine } = await import("@/lib/wakeword");
      const engine = new WakeWordEngine({
        threshold: thresholdRef.current,
        onDetect: () => handleWake(),
        onScore: (s) => {
          setScore(s);
          setPeak((p) => (s > p ? s : p));
        },
        onError: (m) => setReply(`Wake word error: ${m}`),
      });
      await engine.start();
      engineRef.current = engine;
      listeningRef.current = true;
      setListening(true);
      void acquireWakeLock();
    } catch (err: any) {
      setReply(`Couldn't start wake word: ${err?.message || "failed"}`);
    } finally {
      setWakeBusy(false);
    }
  }

  function stopListening() {
    engineRef.current?.stop();
    engineRef.current = null;
    listeningRef.current = false;
    setListening(false);
    void wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  }

  function toggleListening() {
    if (listeningRef.current) stopListening();
    else void startListening();
  }

  // Orb state — all stay BLUE; each state has its own motion/glow effect
  // (no hue swap), so it reads as "more energetic" rather than "different colour".
  const orb =
    status === "recording"
      ? "st-recording"
      : status === "thinking"
      ? "st-thinking"
      : status === "confirming"
      ? "st-confirming"
      : listening
      ? "st-listening"
      : "st-standby";

  // Mirror the live orb state to the global store so the persistent mini-orb on
  // every other tab reflects it (e.g. it lights up if you speak from Calendar).
  useEffect(() => {
    publishOrbState(orb as any);
  }, [orb]);

  const label =
    status === "recording"
      ? captureModeRef.current === "confirm"
        ? "Say “yes” or “no”…"
        : liveSession
        ? "Live — go ahead…"
        : "Listening to you…"
      : status === "thinking"
      ? "Thinking…"
      : status === "confirming"
      ? "Confirm?"
      : wakeBusy
      ? "Starting…"
      : liveSession
      ? "Live conversation — just talk"
      : listening
      ? "Say “Jarvis”"
      : "Tap to start listening";

  const openDeckCard = (key: string) => {
    if (key === "bridge") {
      setBridgeUrl(getBridgeUrl());
      setBridgeTok(getBridgeToken());
      setUserProfileState(getUserProfile());
      setRelaySecretState(getRelaySecret());
      setBridgeOk(null);
      setRelayOnline(null);
    }
    setOpenCard(key);
  };
  const dockCards: { key: string; label: string; n?: string; on?: boolean }[] = [
    // Always offer the Tools card — in the cloud (no bridge) the data tools
    // (tasks, calendar, notes, projects, email, Spotify, messaging, GitHub) still
    // run server-side; only the bridge-only groups need the laptop.
    { key: "tools", label: "Tools", n: `${enabledGroupCount}/${LOCAL_TOOL_GROUPS.length}` },
    { key: "live", label: "Live conversation", on: liveSession },
    { key: "settings", label: "Voice & settings" },
    { key: "bridge", label: "Cloud relay" },
  ];

  return (
    <div className="jarvis-stage">
      {/* Control cards open as a centered popup over a blurred backdrop */}
      {openCard && (
        <div className="deck-modal-overlay" onClick={() => setOpenCard(null)}>
          <div className="deck-modal" onClick={(e) => e.stopPropagation()}>
            <button className="deck-modal-close" onClick={() => setOpenCard(null)} aria-label="Close">✕</button>

            {openCard === "live" && (
              <div className="deck-card-body">
                <h3 className="deck-card-title">Live conversation</h3>
                <button
                  className={`deck-btn ${liveSession ? "" : "ghost"}`}
                  onClick={toggleLiveSession}
                  disabled={!listening}
                  style={{ width: "100%" }}
                >
                  {liveSession ? "■ End live conversation" : "🔊 Start live conversation"}
                </button>
                <p className="deck-hint" style={{ marginTop: ".6rem" }}>
                  {liveSession
                    ? "Just talk — I keep listening after each reply. Say “that’s all” to stop."
                    : "Start a session and talk normally — no need to say “Jarvis” every time. You can also just say “let’s talk”."}
                </p>
              </div>
            )}

            {openCard === "tools" && (
              <div className="deck-card-body">
                <h3 className="deck-card-title">Tools</h3>
                <p className="deck-hint" style={{ marginTop: 0 }}>
                  {presence.bridge
                    ? "Your computer is connected — turns run on JARVIS's local loop. Only checked groups are sent to the model (fewer = smaller prompt)."
                    : "Running in the cloud. The data tools below work without your laptop; the greyed-out groups (open apps, PowerShell, browser) need your computer connected via the Bridge."}
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                  {LOCAL_TOOL_GROUPS.map((g) => {
                    const unavailable = !!g.bridgeOnly && !presence.bridge;
                    return (
                      <label
                        key={g.key}
                        style={{
                          display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13,
                          cursor: unavailable ? "not-allowed" : "pointer",
                          opacity: unavailable ? 0.45 : 1,
                        }}
                        title={unavailable ? "Needs your computer (connect the Bridge)" : g.tools.join(", ")}
                      >
                        <input
                          type="checkbox"
                          checked={!disabledGroups.has(g.key) && !unavailable}
                          disabled={unavailable}
                          onChange={(e) => toggleGroup(g.key, e.target.checked)}
                          style={{ marginTop: 3 }}
                        />
                        <span>
                          <span style={{ fontWeight: 600 }}>{g.label}</span>
                          <span className="mono" style={{ opacity: 0.5, fontSize: 11 }}>
                            {" "}· {g.tools.length} tool{g.tools.length === 1 ? "" : "s"}
                          </span>
                          {unavailable && (
                            <span className="mono" style={{ opacity: 0.6, fontSize: 11 }}> · needs your computer</span>
                          )}
                          <br />
                          <span className="deck-hint" style={{ fontSize: 11 }}>{g.hint}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {openCard === "settings" && (
              <div className="deck-card-body">
                <h3 className="deck-card-title">Voice &amp; detection</h3>
                <div className="deck-row">
                  <span>Live score</span>
                  <span className="mono">{score.toFixed(2)} · pk {peak.toFixed(2)}</span>
                </div>
                <div className="deck-meter">
                  <div className={`deck-meter-fill ${score >= threshold ? "hot" : ""}`} style={{ width: `${Math.min(100, score * 100)}%` }} />
                  <div className="deck-meter-mark" style={{ left: `${threshold * 100}%` }} title="threshold" />
                </div>
                <div className="deck-row">
                  <span>Threshold {threshold.toFixed(2)}</span>
                  <button className="deck-mini" onClick={() => setPeak(0)}>reset peak</button>
                </div>
                <input type="range" min={0} max={1} step={0.01} value={threshold}
                  onChange={(e) => { const v = parseFloat(e.target.value); setThreshold(v); thresholdRef.current = v; engineRef.current?.setThreshold(v); }}
                  className="deck-range" />
                <label className="deck-check">
                  <input type="checkbox" checked={autoSilence}
                    onChange={(e) => { setAutoSilence(e.target.checked); autoSilenceRef.current = e.target.checked; }} />
                  Auto-stop when I go quiet
                </label>
                <div className="deck-row"><span>Max window {(recordMs / 1000).toFixed(0)}s</span></div>
                <input type="range" min={3} max={20} step={1} value={recordMs / 1000}
                  onChange={(e) => { const ms = parseInt(e.target.value, 10) * 1000; setRecordMs(ms); recordMsRef.current = ms; }}
                  className="deck-range" />

                <label className="deck-label">Jarvis voice</label>
                <Select
                  value={voiceURI}
                  onChange={(v) => {
                    setVoiceURI(v); voiceURIRef.current = v; localStorage.setItem("tts.voice", v);
                    // Warm the Piper model in the background so the first reply
                    // isn't delayed by the one-time download/init.
                    if (isPiperVoiceURI(v)) {
                      try { void getPiperEngine(piperVoiceId(v)).prewarm(); } catch { /* ignore */ }
                    }
                  }}
                  options={[
                    { value: "", label: "Default (auto English)" },
                    ...PIPER_VOICES.map((v) => ({ value: piperVoiceURI(v.id), label: v.label })),
                    ...voices.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})${v.localService ? "" : " — online"}` })),
                  ]}
                  className="deck-select"
                />
                <div className="deck-row" style={{ marginTop: ".6rem" }}>
                  <span>Speed {speechRate.toFixed(2)}×</span>
                  <button className="deck-mini" onClick={() => speak("Systems online. How can I help?")}>test voice</button>
                </div>
                <input type="range" min={0.7} max={1.4} step={0.05} value={speechRate}
                  onChange={(e) => { const r = parseFloat(e.target.value); setSpeechRate(r); speechRateRef.current = r; localStorage.setItem("tts.rate", String(r)); }}
                  className="deck-range" />
                <div className="deck-row"><span>Reply length {maxWords} words</span></div>
                <input type="range" min={5} max={60} step={1} value={maxWords}
                  onChange={(e) => { const n = parseInt(e.target.value, 10); setMaxWords(n); maxWordsRef.current = n; localStorage.setItem("reply.maxWords", String(n)); }}
                  className="deck-range" />
                <label className="deck-check">
                  <input type="checkbox" checked={useSnapshot}
                    onChange={(e) => { setUseSnapshot(e.target.checked); useSnapshotRef.current = e.target.checked; localStorage.setItem("agent.snapshot", String(e.target.checked)); }} />
                  Send my data as context
                </label>
                <p className="deck-hint">
                  Lets Jarvis edit/delete items by name. Turn off for fewer tokens —
                  ref commands (“delete task 3”) still work.
                </p>
                {listening && (
                  <button className="deck-link" onClick={toggleListening}>stop listening</button>
                )}
              </div>
            )}

            {openCard === "bridge" && (
              <div className="deck-card-body">
                <h3 className="deck-card-title">Cloud relay</h3>
                <p className="deck-hint">
                  Drive this computer from anywhere — phone or browser. The laptop
                  bridge auto-starts at login and connects out to the cloud; set the
                  same <code>RELAY_SECRET</code> in Vercel and on the bridge, then
                  paste it here.
                </p>
                <label className="deck-label">Relay secret</label>
                <input
                  type="password"
                  value={relaySecret}
                  onChange={(e) => setRelaySecretState(e.target.value)}
                  placeholder="paste your relay secret"
                  className="deck-input"
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                  <button className="deck-btn" onClick={() => { setRelaySecret(relaySecret); setRelayOnline(null); }}>Save</button>
                  <button className="deck-btn ghost" onClick={async () => {
                    setRelaySecret(relaySecret);
                    const p = await fetchRelayPresence();
                    setRelayOnline(p.online);
                  }}>Check computer</button>
                  {relayOnline === true && <span style={{ color: "#5fd39a" }}>● computer online</span>}
                  {relayOnline === false && <span style={{ color: "var(--t2)" }}>○ computer offline</span>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <button className="deck-btn ghost" disabled={bridgeBusy !== null} onClick={async () => {
                    setBridgeBusy("autostart"); setBridgeMsg("");
                    const r = await installAutostart();
                    setBridgeBusy(null);
                    setBridgeMsg(r.ok ? (r.message || "Auto-start at login is on.") : `Failed: ${r.error}`);
                  }}>{bridgeBusy === "autostart" ? "Enabling…" : "Enable auto-start"}</button>
                  <button className="deck-btn ghost" disabled={bridgeBusy !== null} onClick={async () => {
                    setBridgeBusy("restart"); setBridgeMsg("");
                    const r = await restartBridge();
                    setBridgeMsg(r.ok ? "Restarting — checking back in a few seconds…" : `Failed: ${r.error}`);
                    if (!r.ok) { setBridgeBusy(null); return; }
                    // The bridge drops for ~2s as it relaunches; then re-probe presence.
                    setTimeout(async () => {
                      const p = await fetchRelayPresence();
                      setRelayOnline(p.online);
                      setBridgeBusy(null);
                      setBridgeMsg(p.online ? "Bridge restarted — computer online." : "Restarted — still offline, check RELAY_SECRET / RELAY_URL.");
                    }, 4500);
                  }}>{bridgeBusy === "restart" ? "Restarting…" : "Restart bridge"}</button>
                </div>
                <p className="deck-hint">
                  <strong>Enable auto-start</strong> makes the bridge launch at every login.{" "}
                  <strong>Restart bridge</strong> reloads <code>.env.local</code> (apply secret / URL edits).
                  {bridgeMsg && <><br /><span style={{ color: "var(--t2)" }}>{bridgeMsg}</span></>}
                </p>
                {presence.bridge && (
                  <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                    <div className="deck-row">
                      <span>Developer mode {shellEnabled ? <span style={{ color: "var(--u4c)" }}>● ON</span> : <span style={{ color: "var(--t2)" }}>○ off</span>}</span>
                      <button className="deck-btn" disabled={devBusy} onClick={async () => {
                        setDevBusy(true); const r = await setDevMode(!shellEnabled); setDevBusy(false);
                        if (r.ok) setShellEnabled(!!r.shellEnabled);
                      }}>{devBusy ? "…" : shellEnabled ? "Turn off" : "Turn on"}</button>
                    </div>
                    <p className="deck-hint">
                      Lets Jarvis run PowerShell commands (tap-confirmed each time).
                      Only enable on a machine you trust.
                    </p>
                    <label className="deck-label">Default folder to open from</label>
                    <input value={userProfile} onChange={(e) => setUserProfileState(e.target.value)} onBlur={() => setUserProfile(userProfile)} placeholder="C:\\Users\\You\\Downloads" className="deck-input" />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Spatial command core */}
      <div className="jarvis-center">
        <div className="jarvis-heading">
          <p className="jarvis-kicker">Private command layer</p>
          <h1 className="jarvis-title">JARVIS</h1>
          <p className="jarvis-caption">{label}</p>
        </div>

        <button
          onClick={() => {
            if (!listening) void startListening();
          }}
          className={`jarvis-orb ${orb}`}
          aria-label={label}
        >
          <span className="jarvis-core-aura" aria-hidden />
          <SwirlOrb state={orb as any} />
          <span className="jarvis-core-frame frame-a" aria-hidden />
          <span className="jarvis-core-frame frame-b" aria-hidden />
          <span className="jarvis-core-node" aria-hidden />
        </button>

        {/* Capture controls sit right on top of the prompt while active */}
        {(status === "recording" || status === "thinking") && (
          <div className="deck-capture">
            {status === "recording" && (
              <button className="deck-btn" onClick={stopRecording}>■ Stop &amp; send</button>
            )}
            <button className="deck-btn ghost" onClick={cancel}>✕ Cancel</button>
          </div>
        )}

        {/* Typed command — skip speech-to-text when you want exact wording. */}
        <form
          className="jarvis-type"
          onSubmit={(e) => {
            e.preventDefault();
            const q = typed;
            setTyped("");
            void sendText(q);
          }}
        >
          <input
            className="jarvis-type-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Ask, plan, or run something"
            disabled={status === "thinking"}
          />
          <button
            type="submit"
            className="jarvis-type-send"
            disabled={!typed.trim() || status === "thinking"}
            aria-label="Send typed command"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12h13M13 6l6 6-6 6" />
            </svg>
          </button>
        </form>

        {/* Compact control dock. */}
        <div className="deck-dock">
          <div className="deck-dock-track">
            {dockCards.map((c) => (
                <button
                  key={c.key}
                  className={`deck-chip${c.on ? " on" : ""}`}
                  onClick={() => openDeckCard(c.key)}
                >
                  <span>{c.label}</span>
                  {c.n && <span className="deck-chip-n">{c.n}</span>}
                </button>
              ))}
          </div>
        </div>
      </div>

      {/* ── Right feed: conversation + confirmations (kept OFF the centered
            column so they never push the orb or scroll the page) ── */}
      <aside className="jarvis-feed">
        {pendingAction && (
          <div className="jarvis-confirm">
            <p>
              {pendingAction.local_action === "shutdown" ? (
                <>
                  <span className="font-semibold">{pendingAction.label}</span>?
                </>
              ) : (
                <>
                  {pendingAction.local_action === "whatsapp_send" ? "Send" : "Open"}{" "}
                  <span className="font-semibold">{pendingAction.label}</span> on your
                  computer?
                </>
              )}
            </p>
            <div className="flex gap-2">
              <button className="deck-btn" onClick={manualConfirm}>
                ✓ Allow
              </button>
              <button className="deck-btn ghost" onClick={manualDeny}>
                ✕ Deny
              </button>
            </div>
            <p className="deck-hint">Or just say “yes” or “no”.</p>
          </div>
        )}

        {pendingBrowser && (
          <div className="jarvis-confirm">
            <p>
              In your browser: <span className="font-semibold">{pendingBrowser.say}</span>?
            </p>
            <div className="flex gap-2">
              <button className="deck-btn" onClick={manualConfirm}>
                ✓ Allow
              </button>
              <button className="deck-btn ghost" onClick={manualDeny}>
                ✕ Deny
              </button>
            </div>
            <p className="deck-hint">Or just say “yes” or “no”.</p>
          </div>
        )}

        {pendingShell && (
          <div className="jarvis-confirm">
            <p>
              Run this command on your computer?{" "}
              <span className="deck-hint">({pendingShell.label})</span>
            </p>
            <pre className="shell-cmd">{pendingShell.command}</pre>
            <div className="flex gap-2">
              <button
                className="deck-btn"
                onClick={runPendingShell}
                disabled={shellRunning}
              >
                {shellRunning ? "Running…" : "▶ Run"}
              </button>
              <button
                className="deck-btn ghost"
                onClick={cancelPendingShell}
                disabled={shellRunning}
              >
                ✕ Cancel
              </button>
            </div>
            <p className="deck-hint">
              Read the exact command above — it runs as written. Tap to confirm
              (no voice).
            </p>
          </div>
        )}

        {shellOutput != null && shellOutput !== "" && (
          <pre className="shell-out">{shellOutput}</pre>
        )}

        {transcript && (
          <p className="jarvis-line">
            <span className="jarvis-line-tag">YOU</span> {transcript}
          </p>
        )}
        {reply && (
          <div className="jarvis-reply">
            <p>
              <span className="jarvis-line-tag accent">JARVIS</span> {reply}
            </p>
            {speaking ? (
              <button
                className="replay-btn stop"
                onClick={stopSpeaking}
                title="Stop Jarvis talking"
              >
                <span className="replay-ico" aria-hidden>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                    <rect x="5" y="5" width="14" height="14" rx="2" />
                  </svg>
                </span>
                Stop
              </button>
            ) : (
              status === "idle" && (
                <button
                  className="replay-btn"
                  onClick={() => speak(reply)}
                  title="Replay reply"
                >
                  <span className="replay-ico" aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
                      strokeLinejoin="round">
                      <path d="M3 12a9 9 0 1 0 3-6.7" />
                      <path d="M3 3v4h4" />
                    </svg>
                  </span>
                  Replay
                </button>
              )
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
