"use client";

import { useEffect, useState } from "react";
import {
  subscribeToasts,
  subscribeConfirms,
  dismissToast,
  resolveConfirm,
  type ToastItem,
  type ConfirmReq,
} from "@/lib/toast";

export default function ToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirms, setConfirms] = useState<ConfirmReq[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);
  useEffect(() => subscribeConfirms(setConfirms), []);

  const top = confirms[0];

  return (
    <>
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismissToast(t.id)}>
            <span className="toast-dot" />
            <span className="toast-msg">{t.msg}</span>
          </div>
        ))}
      </div>

      {top && (
        <div className="confirm-overlay" onClick={() => resolveConfirm(top.id, false)}>
          <div className="confirm-card" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-msg">{top.msg}</p>
            <div className="confirm-actions">
              <button className="confirm-btn ghost" onClick={() => resolveConfirm(top.id, false)}>
                Cancel
              </button>
              <button
                className={`confirm-btn${top.danger ? " danger" : ""}`}
                onClick={() => resolveConfirm(top.id, true)}
                autoFocus
              >
                {top.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
