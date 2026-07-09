// Browser wake-word engine ("Jarvis") using the openWakeWord ONNX pipeline.
// All inference runs locally in the browser via onnxruntime-web (WASM) — no
// server calls, so it's free. Pipeline per step:
//   mic audio (16kHz) -> melspectrogram.onnx -> embedding_model.onnx
//                     -> jarvis.onnx -> wake probability
import * as ort from "onnxruntime-web";

const SAMPLE_RATE = 16000;
const HOP = 1280; // samples per step (80ms @ 16kHz) => 8 new mel frames
const MEL_FEED = 1920; // audio fed to mel model (HOP + 640 context)
const MEL_HOP_FRAMES = 8; // frames produced per HOP
const MEL_WINDOW = 76; // mel frames per embedding
const MEL_BINS = 32;
const MEL_RING = 256; // mel frames we keep
const EMB_WINDOW = 16; // embeddings the wake model expects
const EMB_DIM = 96;
const MAX_BACKLOG = SAMPLE_RATE * 2; // drop audio if we fall >2s behind
const COOLDOWN_MS = 1500; // ignore repeat fires within this window
const INT16 = 32767;

// Linear-resample a buffer from inRate to 16kHz.
function to16k(input: Float32Array, inRate: number): Float32Array {
  if (inRate === SAMPLE_RATE) return input;
  const ratio = inRate / SAMPLE_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (idx - i0);
  }
  return out;
}

// Serve the WASM runtime from a CDN so we don't have to bundle/copy .wasm files.
ort.env.wasm.wasmPaths =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";

export type WakeWordOptions = {
  threshold?: number; // 0..1, higher = fewer false triggers
  onDetect: (score: number) => void;
  onScore?: (score: number) => void; // live score every step, for tuning
  onError?: (msg: string) => void;
};

export class WakeWordEngine {
  private mel!: ort.InferenceSession;
  private emb!: ort.InferenceSession;
  private wake!: ort.InferenceSession;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  private inRate = SAMPLE_RATE;
  private queue = new Float32Array(0); // pending 16kHz samples (scaled)
  private context = new Float32Array(0); // recent audio for mel context
  private melRing: Float32Array[] = []; // rolling mel frames
  private embBuffer: Float32Array[] = []; // rolling embeddings
  private processing = false;
  private lastFire = 0;
  private paused = false;

  private threshold: number;
  private onDetect: (score: number) => void;
  private onScore?: (score: number) => void;
  private onError?: (msg: string) => void;

  constructor(opts: WakeWordOptions) {
    this.threshold = opts.threshold ?? 0.5;
    this.onDetect = opts.onDetect;
    this.onScore = opts.onScore;
    this.onError = opts.onError;
  }

  setThreshold(t: number) {
    this.threshold = t;
  }

  async start() {
    const modelUrl = async (name: string) => {
      const desktopApi = (globalThis as unknown as {
        jarvisDesktop?: { getModelUrl?: (name: string) => Promise<string> };
      }).jarvisDesktop;
      return desktopApi?.getModelUrl ? await desktopApi.getModelUrl(name) : `/models/${name}`;
    };
    [this.mel, this.emb, this.wake] = await Promise.all([
      ort.InferenceSession.create(await modelUrl("melspectrogram.onnx"), {
        executionProviders: ["wasm"],
      }),
      ort.InferenceSession.create(await modelUrl("embedding_model.onnx"), {
        executionProviders: ["wasm"],
      }),
      ort.InferenceSession.create(await modelUrl("jarvis.onnx"), {
        executionProviders: ["wasm"],
      }),
    ]);

    // Don't force the context rate (hardware often ignores it) — read the real
    // rate and resample ourselves so the model always gets true 16kHz.
    this.ctx = new AudioContext();
    this.inRate = this.ctx.sampleRate;
    // ALL three processing flags MUST stay off. Chrome routes audio output
    // through its WebRTC "communications" processing pipeline whenever an open
    // mic stream enables ANY of echoCancellation / noiseSuppression /
    // autoGainControl — that pipeline ducks and badly muffles anything playing
    // (e.g. Spotify) for as long as Jarvis listens. Disabling all three keeps
    // the mic on the raw audio path; the wake model + Whisper handle raw fine.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => this.onAudio(e.inputBuffer.getChannelData(0));
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination);
    // Browsers start the context suspended until a user gesture.
    await this.ctx.resume().catch(() => {});
  }

  // True once audio is actually flowing (context running).
  get running() {
    return this.ctx?.state === "running";
  }

  // Background tabs can suspend the AudioContext; call this to nudge it back
  // to "running". Returns whether audio is flowing afterwards.
  async ensureRunning(): Promise<boolean> {
    if (this.ctx && this.ctx.state === "suspended") {
      await this.ctx.resume().catch(() => {});
    }
    return this.ctx?.state === "running";
  }

  // The live mic stream, so the recorder can reuse it instead of opening a
  // second capture (a 2nd getUserMedia often returns silent audio on Windows).
  get micStream(): MediaStream | null {
    return this.stream;
  }

  // Pause detection (e.g. while the assistant is recording the actual command).
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
    this.embBuffer = []; // avoid stale context after a pause
    this.melRing = [];
  }

  stop() {
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
    this.queue = new Float32Array(0);
    this.context = new Float32Array(0);
    this.melRing = [];
    this.embBuffer = [];
  }

  private onAudio(samples: Float32Array) {
    if (this.paused) return;
    const resampled = to16k(samples, this.inRate);
    // Scale [-1,1] to int16 range (what the mel model expects) and enqueue.
    const scaled = new Float32Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) scaled[i] = resampled[i] * INT16;

    let merged = new Float32Array(this.queue.length + scaled.length);
    merged.set(this.queue);
    merged.set(scaled, this.queue.length);
    // Drop oldest audio if we've fallen too far behind real time.
    if (merged.length > MAX_BACKLOG) merged = merged.slice(merged.length - MAX_BACKLOG);
    this.queue = merged;
    void this.pump();
  }

  // Process whole HOPs sequentially so embedding spacing stays exactly 8 frames.
  private async pump() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length >= HOP) {
        const hop = this.queue.slice(0, HOP);
        this.queue = this.queue.slice(HOP);
        await this.runHop(hop);
      }
    } catch (err: any) {
      this.onError?.(err?.message || "wake word error");
    } finally {
      this.processing = false;
    }
  }

  private async runHop(hop: Float32Array) {
    // Feed HOP + trailing context to the mel model, keep the newest 8 frames.
    const feed = new Float32Array(this.context.length + hop.length);
    feed.set(this.context);
    feed.set(hop, this.context.length);
    this.context = feed.slice(Math.max(0, feed.length - (MEL_FEED - HOP)));

    const melOut = (
      await this.mel.run({ input: new ort.Tensor("float32", feed, [1, feed.length]) })
    ).output;
    const dims = melOut.dims; // [1,1,F,32]
    const frames = dims[dims.length - 2];
    const md = melOut.data as Float32Array;
    const take = Math.min(MEL_HOP_FRAMES, frames);
    for (let f = frames - take; f < frames; f++) {
      const frame = new Float32Array(MEL_BINS);
      for (let b = 0; b < MEL_BINS; b++) frame[b] = md[f * MEL_BINS + b] / 10 + 2;
      this.melRing.push(frame);
    }
    if (this.melRing.length > MEL_RING)
      this.melRing.splice(0, this.melRing.length - MEL_RING);
    if (this.melRing.length < MEL_WINDOW) return;

    // One embedding from the most recent 76 mel frames.
    const embInput = new Float32Array(MEL_WINDOW * MEL_BINS);
    const startF = this.melRing.length - MEL_WINDOW;
    for (let f = 0; f < MEL_WINDOW; f++)
      embInput.set(this.melRing[startF + f], f * MEL_BINS);
    const embOut = (
      await this.emb.run({
        input_1: new ort.Tensor("float32", embInput, [1, MEL_WINDOW, MEL_BINS, 1]),
      })
    ).conv2d_19;
    this.embBuffer.push(Float32Array.from(embOut.data as Float32Array));
    if (this.embBuffer.length > EMB_WINDOW) this.embBuffer.shift();
    if (this.embBuffer.length < EMB_WINDOW) return;

    // Wake classifier over the last 16 embeddings.
    const wakeData = new Float32Array(EMB_WINDOW * EMB_DIM);
    for (let i = 0; i < EMB_WINDOW; i++) wakeData.set(this.embBuffer[i], i * EMB_DIM);
    const wakeOut = await this.wake.run({
      "onnx::Flatten_0": new ort.Tensor("float32", wakeData, [1, EMB_WINDOW, EMB_DIM]),
    });
    const score = (wakeOut["39"].data as Float32Array)[0];
    this.onScore?.(score);

    const now = performance.now();
    if (score >= this.threshold && now - this.lastFire >= COOLDOWN_MS) {
      this.lastFire = now;
      this.embBuffer = [];
      this.onDetect(score);
    }
  }
}
