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

/** 挂在 AppProviders 上，features 只经 useConfirm() 取用。 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const queueRef = React.useRef<ConfirmQueue | null>(null);
  const [, setTick] = React.useState(0);
  if (!queueRef.current) queueRef.current = createConfirmQueue(() => setTick((t) => t + 1));
  const queue = queueRef.current;
  const head = queue.peek();
  const request = head?.request;
  const headId = head?.id ?? 0;
  return (
    <ConfirmCtx.Provider value={queue}>
      {children}
      <AlertDialog
        open={head !== null}
        onOpenChange={(open) => {
          if (!open) queue.settle(headId, false);
        }}
      >
        {request ? (
          // key 绑队首 id：换条目时整块重挂，不沿用上一条内容。
          <AlertDialogContent key={headId} className="max-w-[420px]">
            <AlertDialogHeader>
              <AlertDialogTitle>{request.title}</AlertDialogTitle>
              {/* 无正文时仍需 aria-describedby 指向：保留节点供屏读。 */}
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

export function useConfirm(): (request: ConfirmRequest) => Promise<boolean> {
  const queue = React.useContext(ConfirmCtx);
  return React.useCallback((request: ConfirmRequest) => {
    if (!queue) throw new Error("useConfirm 必须在 ConfirmProvider 内使用");
    return queue.open(request);
  }, [queue]);
}

export type { ConfirmRequest };
