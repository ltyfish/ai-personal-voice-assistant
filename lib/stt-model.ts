export const DEFAULT_STT_MODEL = "whisper-large-v3";
export const FAST_STT_MODEL = "whisper-large-v3-turbo";

export function selectSttModel(mode: unknown) {
  return mode === "fast" ? FAST_STT_MODEL : DEFAULT_STT_MODEL;
}
