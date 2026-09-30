import type { ReactNode } from "react";

/** 确认框的入参。title 是一句问话，description 说清「按确认会发生什么、能不能回退」。 */
export interface ConfirmRequest {
  title: string;
  /** 允许传 ReactNode：受影响的对象清单这类内容原生 confirm 只能靠 \n 拼，组件里应是列表。 */
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** destructive 把确认按钮换成红标令牌，用于不可逆动作。 */
  tone?: "default" | "destructive";
}

export interface ConfirmEntry {
  id: number;
  request: ConfirmRequest;
  /** 幂等决议：同一个条目被决议两次（按钮与 Esc 竞态）时第二次不起作用。 */
  settle: (ok: boolean) => void;
}

export interface ConfirmQueue {
  open(request: ConfirmRequest): Promise<boolean>;
  /** 队首即当前应显示的确认框；null 表示屏幕上没有确认框。 */
  peek(): ConfirmEntry | null;
  /** 只有 id 仍是队首才决议。 */
  settle(id: number, ok: boolean): void;
  pending(): number;
}

/**
 * 一次 ask 产出一个 Promise，队列保证同屏只有一个确认框、且按发起顺序依次弹出。
 * notify 在队首变化时回调（React 侧用它重绘），本模块不含任何 React 依赖，可在 node 环境直接测。
 */
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
