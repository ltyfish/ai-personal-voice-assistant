// Lightweight global toast + confirm system — replaces native alert()/confirm()
// with the app's own black-&-white styled notifications and modal.
export type ToastKind = "info" | "success" | "error";
export type ToastItem = { id: number; msg: string; kind: ToastKind };
export type ConfirmReq = {
  id: number;
  msg: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
};

let toasts: ToastItem[] = [];
let confirms: ConfirmReq[] = [];
const tSubs = new Set<(t: ToastItem[]) => void>();
const cSubs = new Set<(c: ConfirmReq[]) => void>();
let nid = 1;

export function notify(msg: string, kind: ToastKind = "info") {
  const item: ToastItem = { id: nid++, msg, kind };
  toasts = [...toasts, item];
  tSubs.forEach((f) => f(toasts));
  setTimeout(() => dismissToast(item.id), 4500);
  return item.id;
}
export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  tSubs.forEach((f) => f(toasts));
}
export function subscribeToasts(f: (t: ToastItem[]) => void) {
  tSubs.add(f);
  return () => {
    tSubs.delete(f);
  };
}

export function confirmDialog(
  msg: string,
  opts: { confirmLabel?: string; danger?: boolean } = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    const req: ConfirmReq = {
      id: nid++,
      msg,
      confirmLabel: opts.confirmLabel ?? "Confirm",
      danger: !!opts.danger,
      resolve,
    };
    confirms = [...confirms, req];
    cSubs.forEach((f) => f(confirms));
  });
}
export function resolveConfirm(id: number, ok: boolean) {
  const r = confirms.find((c) => c.id === id);
  if (r) r.resolve(ok);
  confirms = confirms.filter((c) => c.id !== id);
  cSubs.forEach((f) => f(confirms));
}
export function subscribeConfirms(f: (c: ConfirmReq[]) => void) {
  cSubs.add(f);
  return () => {
    cSubs.delete(f);
  };
}
