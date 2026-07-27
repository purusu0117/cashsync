"use client";

// 完了フィードバックのトースト（A6）：かんたん入力（プリセット）と同じ様式を全画面で共有する。
// 「元に戻す」つき（削除Undo等）は考える時間を長めに8秒、通常メッセージは4秒で消える。
import { useCallback, useEffect, useRef, useState } from "react";

export interface ToastState {
  msg: string;
  undo?: () => void;
}

export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((msg: string, undo?: () => void) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ msg, undo });
    timer.current = setTimeout(() => setToast(null), undo ? 8000 : 4000);
  }, []);
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setToast(null);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return { toast, show, hide };
}

export function Toast({ toast, hide }: { toast: ToastState | null; hide: () => void }) {
  if (!toast) return null;
  return (
    <div className="fixed bottom-24 left-1/2 z-[70] flex w-[calc(100%-3rem)] max-w-sm -translate-x-1/2 items-center gap-2 rounded-md bg-ink px-4 py-3 text-sm text-card shadow-lg">
      <span className="min-w-0 flex-1">{toast.msg}</span>
      {toast.undo && (
        <button
          onClick={() => {
            const u = toast.undo;
            hide();
            u?.();
          }}
          className="dot shrink-0 rounded border border-card/70 px-2.5 py-1 text-xs"
        >
          元に戻す
        </button>
      )}
    </div>
  );
}
