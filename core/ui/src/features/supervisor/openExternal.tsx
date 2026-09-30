/** 外部打开结果的唯一呈现口：内核三档（confirmed / handedOff / ok:false）在此各有说法，
 *  且**任何一档都把地址交到用户眼前**（可点、可复制）。
 *  页面不得自行拼这类 toast —— 「按钮点了没反应却显示成功」正是各处各自表述成败的结果。 */
import { Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { classifyOpenResult, handOffFromPanel } from "../../services/supervisor/externalOpen";
import type { OpenExternalResult } from "../../services/supervisor";

/** 地址条：点开（本机内核托管时请内核开浏览器，否则用访客自己的浏览器）+ 复制；
 *  复制失败时明示要手动选中。导出给需要把地址常驻的调用方（一键登录等回调可长达三分钟，
 *  toast 十几秒就消失，等待期间用户只剩这一条出路）。 */
export function OpenUrlRow({ url }: { url: string }) {
  async function onOpen() {
    // 与端点同一套呈现：三档各说一句，任何一档地址都仍在眼前（这里不另造成败说法）。
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

/** 结果正文：地址行恒在最前，其下是本次的启动形态（bin | via | 退出码）。
 *  confirmed 档不摊细节（证据已经说完了），另两档必须说清「凭的是什么」，否则用户只能猜。 */
function OpenResultBody({ url, detail }: { url: string | null; detail: string | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {url ? <OpenUrlRow url={url} /> : null}
      {detail ? <div className="break-all font-mono text-[10px] text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

/** 一次外部打开结果的呈现（不抛错：这一步没有可失败的后端动作）。
 *  摊不摊证据行由服务层的 reveal 决定（判据见 classifyOpenResult），组件不自判：
 *  「白窗口现场该看见什么」写在渲染侧就没法在 CI 里判红。 */
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

/** 发起 + 呈现的唯一入口。后端把「动作未被接受」映射为非 2xx（GD 条），而失败响应体里的地址
 *  仍必须呈现，故 catch 里优先取 err.body，取不到才退化成一句错误文案。
 *  泛型：调用方的端点带额外字段（如登录发起的 authUrl/isolated）时原样交出，不必二次请求。 */
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
