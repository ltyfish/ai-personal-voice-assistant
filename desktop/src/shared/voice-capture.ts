export const MIN_CAPTURE_MS = 700;
export const SILENCE_STOP_MS = 800;
export const MAX_CAPTURE_MS = 5200;

type SilenceStopState = {
  elapsedMs: number;
  speechObserved: boolean;
  silentForMs: number;
};

export function shouldStopForSilence(state: SilenceStopState) {
  if (state.elapsedMs >= MAX_CAPTURE_MS) return true;
  return (
    state.elapsedMs >= MIN_CAPTURE_MS &&
    state.speechObserved &&
    state.silentForMs >= SILENCE_STOP_MS
  );
}
