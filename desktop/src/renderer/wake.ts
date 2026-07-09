import type { WakeWordEngine } from "../../../lib/wakeword.js";

export type WakeHandle = {
  stream: MediaStream | null;
  ensureRunning(): Promise<boolean>;
  pause(): void;
  resume(): void;
  stop(): void;
};

export async function startWakeListener(onWake: () => void, onScore: (score: number) => void): Promise<WakeHandle> {
  const { WakeWordEngine } = await import("../../../lib/wakeword.js");
  const engine: WakeWordEngine = new WakeWordEngine({
    threshold: 0.5,
    onDetect: () => {
      console.info("wake word detected");
      onWake();
    },
    onScore,
    onError: (msg: string) => console.warn("wake word error", msg),
  });
  await engine.start();
  console.info("wake listener started");
  return {
    get stream() {
      return engine.micStream;
    },
    ensureRunning() {
      return engine.ensureRunning();
    },
    pause() {
      engine.pause();
    },
    resume() {
      engine.resume();
      void engine.ensureRunning();
    },
    stop() {
      engine.stop();
    },
  };
}
