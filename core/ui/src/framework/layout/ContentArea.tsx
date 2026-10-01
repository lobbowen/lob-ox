import type { ReactNode } from "react";
import { cn } from "../utils";
import { ScrollArea } from "./ScrollArea";

const INNER_PAD =
  "px-7 pt-5 pb-[18px] max-[980px]:px-6 max-[980px]:pt-2 max-[980px]:pb-6 max-[640px]:px-3.5 max-[640px]:pb-[18px]";

export type ContentAreaProps = {
  children: ReactNode;
  inspector?: ReactNode;
  inspectorWidth?: string;
  className?: string;
};

export function ContentArea({
  children,
  inspector,
  inspectorWidth = "318px",
  className,
}: ContentAreaProps) {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden bg-background",
        className,
      )}
    >
      {inspector ? (
        <div
          className={cn(
            "grid h-full gap-[18px]",
            "grid-cols-[minmax(0,1fr)_" + inspectorWidth + "]",
          )}
        >
          <ScrollArea className="min-h-0">
            <div className="@container">
              <div className={INNER_PAD}>{children}</div>
            </div>
          </ScrollArea>
          <ScrollArea className="min-h-0 rounded-lg">
            <div className="@container">
              <div className={cn("grid content-start gap-3", INNER_PAD)}>{inspector}</div>
            </div>
          </ScrollArea>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="@container">
            <div className={INNER_PAD}>{children}</div>
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
