// Piper neural TTS in the browser (WASM + ONNX). A higher-quality, more natural
// alternative to the OS `speechSynthesis` voices. Everything runs locally:
// the voice model (~10-60MB) is downloaded once from a CDN and cached in OPFS,
// then inference + playback happen client-side with no server round-trip.
//
// We keep a single TtsSession warm per voice so the model stays resident between
// utterances (the first call pays the download/init cost; later calls are fast),
// and play the synthesized WAV through a sequenced AudioContext queue so streamed
// sentences play back-to-back without gaps.
//
// The package is browser-only (OPFS/Workers/WASM), so it is always imported
// lazily inside async functions — never at module top — to stay SSR-safe.

export type PiperVoice = {
  id: string; // piper voiceId, e.g. "en_US-hfc_female-medium"
  label: string;
  quality: "x_low" | "low" | "medium" | "high";
};

// URIs in the voice picker are prefixed so we can tell a Piper voice apart from
// an OS speechSynthesis voiceURI.
export const PIPER_PREFIX = "piper:";
export const isPiperVoiceURI = (uri: string) => uri.startsWith(PIPER_PREFIX);
export const piperVoiceId = (uri: string) => uri.slice(PIPER_PREFIX.length);
export const piperVoiceURI = (id: string) => PIPER_PREFIX + id;

// Curated English voices. Lower quality == lower latency (smaller model, faster
// inference); "medium" is the recommended quality/latency balance. The full
// Piper catalogue is large and multilingual — we surface a clean English subset.
export const PIPER_VOICES: PiperVoice[] = [
  { id: "en_US-hfc_female-medium", label: "Piper · US Female (HFC) — natural", quality: "medium" },
  { id: "en_US-amy-medium", label: "Piper · US Amy — natural", quality: "medium" },
  { id: "en_US-amy-low", label: "Piper · US Amy — fast", quality: "low" },
  { id: "en_US-hfc_male-medium", label: "Piper · US Male (HFC) — natural", quality: "medium" },
  { id: "en_US-ryan-medium", label: "Piper · US Ryan (male) — natural", quality: "medium" },
  { id: "en_US-ryan-low", label: "Piper · US Ryan (male) — fast", quality: "low" },
  { id: "en_US-lessac-medium", label: "Piper · US Lessac — natural", quality: "medium" },
  { id: "en_US-lessac-low", label: "Piper · US Lessac — fast", quality: "low" },
  { id: "en_US-libritts_r-medium", label: "Piper · US LibriTTS-R — expressive", quality: "medium" },
  { id: "en_US-joe-medium", label: "Piper · US Joe (male) — natural", quality: "medium" },
  { id: "en_US-kristin-medium", label: "Piper · US Kristin — natural", quality: "medium" },
  { id: "en_GB-alan-medium", label: "Piper · UK Alan (male) — natural", quality: "medium" },
  { id: "en_GB-alan-low", label: "Piper · UK Alan (male) — fast", quality: "low" },
  { id: "en_GB-cori-medium", label: "Piper · UK Cori (female) — natural", quality: "medium" },
  { id: "en_GB-jenny_dioco-medium", label: "Piper · UK Jenny — natural", quality: "medium" },
  { id: "en_GB-northern_english_male-medium", label: "Piper · UK Northern Male — natural", quality: "medium" },
  { id: "en_GB-southern_english_female-low", label: "Piper · UK Southern Female — fast", quality: "low" },
];

type Handlers = {
  onStart?: () => void;
  onEnd?: () => void; // fires once playback fully drains (or on error/stop)
};

// A warm Piper engine bound to one voice. Reused across utterances; rebuilt only
// when the selected voice changes.
class PiperEngine {
  readonly voiceId: string;
  private sessionP: Promise<any> | null = null;
  private ctx: AudioContext | null = null;
  // Monotonic token: bumping it cancels any in-flight synth/playback so a new
  // request (or stop) cleanly abandons the previous one.
  private generation = 0;
  private active = new Set<AudioBufferSourceNode>();
  private speakingCb: ((on: boolean) => void) | null = null;

  constructor(voiceId: string) {
    this.voiceId = voiceId;
  }

  // Report speaking state changes to the caller (so the UI mic indicator works).
  onSpeakingChange(cb: (on: boolean) => void) {
    this.speakingCb = cb;
  }
  private setSpeaking(on: boolean) {
    this.speakingCb?.(on);
  }

  private audioContext(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new AudioContext();
    }
    return this.ctx;
  }

  // Lazily create + cache the TTS session (downloads the model on first use).
  private session(onProgress?: (loaded: number, total: number) => void): Promise<any> {
    if (!this.sessionP) {
      this.sessionP = (async () => {
        const tts = await import("@mintplex-labs/piper-tts-web");
        return tts.TtsSession.create({
          voiceId: this.voiceId as any,
          progress: (p: { loaded: number; total: number }) =>
            onProgress?.(p.loaded, p.total),
        });
      })().catch((e) => {
        // Don't cache a failed init — allow a retry on the next call.
        this.sessionP = null;
        throw e;
      });
    }
    return this.sessionP;
  }

  // Warm the model + audio path so the first real reply isn't slow/silent.
  async prewarm(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    await this.session(onProgress);
    await this.audioContext().resume().catch(() => {});
  }

  // Synthesize one chunk of text to a decoded AudioBuffer.
  private async synth(text: string): Promise<AudioBuffer> {
    const session = await this.session();
    const wav: Blob = await session.predict(text);
    const buf = await wav.arrayBuffer();
    return this.audioContext().decodeAudioData(buf);
  }

  // Speak a single block of text. Resolves (and fires onEnd) when playback ends.
  speak(text: string, rate: number, handlers: Handlers = {}): void {
    void this.run([text], rate, handlers, /* streaming */ false);
  }

  // Streaming speaker: push sentences as they arrive; they synthesize in order
  // and play gaplessly. Call finish() when the source stream ends.
  makeStream(rate: number, handlers: Handlers = {}) {
    const gen = ++this.generation;
    this.stopSources();
    const ctx = this.audioContext();
    void ctx.resume().catch(() => {});
    let nextStart = 0;
    let enqueued = 0;
    let ended = 0;
    let streamDone = false;
    let started = false;
    let finished = false;
    // Serialize synthesis so sentences keep their order and don't fight over the
    // single session.
    let chain: Promise<void> = Promise.resolve();

    const finalize = () => {
      if (finished) return;
      finished = true;
      this.setSpeaking(false);
      handlers.onEnd?.();
    };
    const maybeFinish = () => {
      if (streamDone && ended >= enqueued) finalize();
    };

    const schedule = (audio: AudioBuffer) => {
      if (gen !== this.generation) return; // cancelled
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.playbackRate.value = rate || 1;
      src.connect(ctx.destination);
      const startAt = Math.max(ctx.currentTime, nextStart);
      src.start(startAt);
      nextStart = startAt + audio.duration / (rate || 1);
      this.active.add(src);
      if (!started) {
        started = true;
        this.setSpeaking(true);
        handlers.onStart?.();
      }
      src.onended = () => {
        this.active.delete(src);
        ended++;
        maybeFinish();
      };
    };

    return {
      push: (sentence: string) => {
        if (!sentence.trim() || gen !== this.generation) return;
        enqueued++;
        chain = chain
          .then(() => (gen === this.generation ? this.synth(sentence) : null))
          .then((audio) => {
            if (audio) schedule(audio);
            else {
              ended++;
              maybeFinish();
            }
          })
          .catch(() => {
            ended++; // don't strand the queue if one sentence fails
            maybeFinish();
          });
      },
      finish: () => {
        streamDone = true;
        if (enqueued === 0) finalize();
        else maybeFinish();
      },
    };
  }

  // Speak a fixed list of chunks (used by the non-streaming speak()).
  private async run(chunks: string[], rate: number, handlers: Handlers, _streaming: boolean) {
    const stream = this.makeStream(rate, handlers);
    for (const c of chunks) stream.push(c);
    stream.finish();
  }

  private stopSources() {
    for (const src of this.active) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.active.clear();
  }

  // Immediately silence everything and cancel in-flight synthesis.
  stop() {
    this.generation++;
    this.stopSources();
    this.setSpeaking(false);
  }
}

// One live engine at a time (keyed by voice). Switching voices disposes the old.
let current: PiperEngine | null = null;

export function getPiperEngine(voiceId: string): PiperEngine {
  if (!current || current.voiceId !== voiceId) {
    current?.stop();
    current = new PiperEngine(voiceId);
  }
  return current;
}
