import type { WakeWordEngine } from "../../../lib/wakeword.js";

export type WakeHandle = {
  stop(): void;
};

export async function startWakeListener(onWake: () => void, onScore: (score: number) => void): Promise<WakeHandle> {
  const { WakeWordEngine } = await import("../../../lib/wakeword.js");
  const engine: WakeWordEngine = new WakeWordEngine({
    threshold: 0.5,
    onDetect: () => onWake(),
    onScore,
    onError: (msg: string) => console.warn("wake word error", msg),
  });
  await engine.start();
  return {
    stop() {
      engine.stop();
    },
  };
}
