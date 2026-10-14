import type { ReactNode } from "react";

export interface ConfirmRequest {
  title: string;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: "default" | "destructive";
}

export interface ConfirmEntry {
  id: number;
  request: ConfirmRequest;
  settle: (ok: boolean) => void;
}

export interface ConfirmQueue {
  open(request: ConfirmRequest): Promise<boolean>;
  peek(): ConfirmEntry | null;
  settle(id: number, ok: boolean): void;
  pending(): number;
}

export function createConfirmQueue(notify: () => void = () => {}): ConfirmQueue {
  const waiting: ConfirmEntry[] = [];
  let seq = 0;

  const once = (fn: (ok: boolean) => void) => {
    let done = false;
    return (ok: boolean) => {
      if (done) return;
      done = true;
      fn(ok);
    };
  };

  return {
    open(request) {
      seq += 1;
      const id = seq;
      return new Promise<boolean>((resolve) => {
        waiting.push({ id, request, settle: once(resolve) });
        notify();
      });
    },
    peek() {
      return waiting.length ? waiting[0] : null;
    },
    settle(id, ok) {
      if (!waiting.length || waiting[0].id !== id) return;
      const [entry] = waiting.splice(0, 1);
      entry.settle(ok);
      notify();
    },
    pending() {
      return waiting.length;
    },
  };
}
