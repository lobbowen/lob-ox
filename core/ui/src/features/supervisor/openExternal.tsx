/** 内核外部打开三档协议（confirmed / handed-off / ok:false）：任何一档都必须把地址交到用户眼前。 */
import { Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { classifyOpenResult, handOffFromPanel } from "../../services/supervisor/externalOpen";
import type { OpenExternalResult } from "../../services/supervisor";

export function OpenUrlRow({ url }: { url: string }) {
  async function onOpen() {
    await runOpenExternal(() => handOffFromPanel(url));
  }
  function onCopy() {
    const fallback = () => toast.error("复制失败，请手动选中地址");
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => toast.success("地址已复制"), fallback);
    else fallback();
  }
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{url}</code>
      <button type="button" onClick={() => void onOpen()} title="在系统浏览器中打开该地址" className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
        <ExternalLink className="size-3.5" />
      </button>
      <button type="button" onClick={onCopy} title="复制地址" className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

function OpenResultBody({ url, detail }: { url: string | null; detail: string | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {url ? <OpenUrlRow url={url} /> : null}
      {detail ? <div className="break-all font-mono text-[10px] text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

/** 证据行是否展示由服务层 classifyOpenResult 的 reveal 决定，组件不自判。 */
export function notifyOpen(r?: OpenExternalResult | null): void {
  const { tier, url, title, detail, reveal } = classifyOpenResult(r);
  const shown = reveal ? detail : null;
  const opts = {
    description: url || shown ? <OpenResultBody url={url} detail={shown} /> : undefined,
    duration: tier === "confirmed" ? (reveal ? 12000 : 3000) : 20000,
  };
  if (tier === "confirmed") toast.success(title, opts);
  else if (tier === "handed-off") toast.warning(title, opts);
  else toast.error(title, opts);
}

/** 后端把「动作未被接受」映射为非 2xx，失败响应体里仍带地址，故 catch 优先取 err.body。 */
export async function runOpenExternal<T extends OpenExternalResult>(
  call: () => Promise<T | null | undefined>,
): Promise<T | null> {
  try {
    const r = await call();
    notifyOpen(r);
    return r ?? null;
  } catch (e) {
    const body = (e as { body?: unknown }).body;
    const r: OpenExternalResult = body && typeof body === "object"
      ? (body as OpenExternalResult)
      : { ok: false, error: e instanceof Error ? e.message : String(e) };
    notifyOpen(r);
    return r as T;
  }
}
