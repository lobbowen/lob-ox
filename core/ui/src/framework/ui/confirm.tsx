import * as React from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";
import { Button } from "./button";
import { createConfirmQueue, type ConfirmQueue, type ConfirmRequest } from "./confirm-queue";

const ConfirmCtx = React.createContext<ConfirmQueue | null>(null);

/** 全局唯一确认层：挂在 AppProviders 上，features 只经 useConfirm() 取用。
 *  队列保证同屏一个确认框、按发起顺序依次弹出，因此并发触发（批量卸载里连点）不会互相覆盖。 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const queueRef = React.useRef<ConfirmQueue | null>(null);
  const [, setTick] = React.useState(0);
  if (!queueRef.current) queueRef.current = createConfirmQueue(() => setTick((t) => t + 1));
  const queue = queueRef.current;
  const head = queue.peek();
  const request = head?.request;
  // 无队首时给 0：settle(0, ..) 永不命中任何条目，比在事件回调里重复判空更省事。
  const headId = head?.id ?? 0;
  return (
    <ConfirmCtx.Provider value={queue}>
      {children}
      <AlertDialog
        open={head !== null}
        onOpenChange={(open) => {
          // Esc/取消即决议 false；settle 按 id 校验，已弹出的下一条不受上一次关闭事件影响。
          if (!open) queue.settle(headId, false);
        }}
      >
        {request ? (
          // key 绑队首 id：换条目时正文整块重挂，不会拿上一条的标题渲染队列里的下一条。
          <AlertDialogContent key={headId} className="max-w-[420px]">
            <AlertDialogHeader>
              <AlertDialogTitle>{request.title}</AlertDialogTitle>
              {/* 无正文时仍要有 aria-describedby 指向，故保留节点只作屏读用。 */}
              <AlertDialogDescription asChild className={request.description ? undefined : "sr-only"}>
                <div>{request.description ?? request.title}</div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel asChild>
                <Button variant="outline">{request.cancelText ?? "取消"}</Button>
              </AlertDialogCancel>
              <AlertDialogAction asChild>
                <Button
                  variant={request.tone === "destructive" ? "destructive" : "default"}
                  onClick={() => queue.settle(headId, true)}
                >
                  {request.confirmText ?? "确认"}
                </Button>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </ConfirmCtx.Provider>
  );
}

/** 危险动作的唯一确认出口：await 得到用户的决定，取消/Esc 都是 false。 */
export function useConfirm(): (request: ConfirmRequest) => Promise<boolean> {
  const queue = React.useContext(ConfirmCtx);
  // 缺 Provider 时不能退回「静默 false」——那会让每个危险动作悄悄拒绝且无线索；也不把 throw 放在
  // useCallback 之前，那是 hook 顺序违规（lint 会拦）。
  return React.useCallback((request: ConfirmRequest) => {
    if (!queue) throw new Error("useConfirm 必须在 ConfirmProvider 内使用");
    return queue.open(request);
  }, [queue]);
}

export type { ConfirmRequest };
