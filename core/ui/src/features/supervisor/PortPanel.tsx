/**
 * 运行状态面板（Overview 右侧栏）：/ports 端口注册表反映各服务真实监听状态。
 * 归属语义着色：system(核心服务) / inst(实例) / managed(守护进程) / oauth(登录回调)。
 */
import { useMemo } from "react";
import { CircleDot } from "lucide-react";
import { useSupervisorData, type PortRecord, type RouterProvider } from "../../services/supervisor";
import { Card, CardTitle, Pill } from "./widgets";
import { cn } from "../../framework/utils";

function roleTone(role: string, owner?: string | null): "ok" | "boot" | "warn" | "off" {
  if (role === "dsh-main" || role === "supervisor-api") return "boot";
  if ((owner || "").startsWith("inst:")) return "ok"; // owner 后端可为 null（ports.js owner:||null）-> 必须防空
  if (role === "relay") return "warn";
  if (role.startsWith("managed:")) return "boot";
  return "off";
}
function roleLabel(r: PortRecord): string {
  const map: Record<string, string> = {
    "dsh-main": "DSH 主实例",
    "supervisor-api": "管家 API",
    user: "沙箱实例",
    relay: "局域网隧道",
    oauthCallback: "登录回调",
    proxyInstance: "反代实例",
    providerApi: "供应商 API",
    "managed:router-daemon": "智能路由",
    "managed:lan-daemon": "远程控制",
    dynamic: "动态端口",
  };
  const m = /^managed:(.+)$/.exec(r.role);
  if (m) return map[r.role] ?? m[1];
  return map[r.role] ?? r.role;
}
/** 归属标签化：不暴露账号/内部 id。反代(proxy)归属 -> 供应商名；其余 -> 语义类别。 */
function resolveOwner(r: PortRecord, providers: RouterProvider[]): string {
  const o = r.owner || "";
  if (r.role === "proxyInstance") {
    const tail = o.split(":").pop() || "";
    const tail4 = tail.slice(-4);
    const prov = (providers ?? []).find((pp) => (pp.accounts ?? []).some((a) => (a.maskedKey || "").endsWith(tail4)));
    return prov ? prov.name : "反代";
  }
  if (o.startsWith("inst:")) return "沙箱实例";
  if (o.startsWith("system:")) return "系统";
  if (o.startsWith("relay:")) return "局域网隧道";
  if (o.startsWith("dynamic:")) return "动态";
  if (o.startsWith("providerApi:")) return "供应商";
  if (o.startsWith("oauth:")) return "登录回调";
  if (o === "router-daemon" || r.role === "managed:router-daemon") return "智能路由";
  if (o === "lan-daemon" || r.role === "managed:lan-daemon") return "远程控制";
  if (r.role === "oauthCallback") return "登录回调";
  return r.role;
}
export function PortPanel({ providers = [] }: { providers?: RouterProvider[] }) {
  // /ports 已并入全局 2s 快照（polling.ts syncAll）：直接消费 snap.ports，无独立轮询
  const { snap } = useSupervisorData();
  const raw = snap.ports?.records ?? null;
  const records = useMemo<PortRecord[] | null>(() => {
    if (!raw) return null;
    // 过滤：已废弃旧端口 3100/3101（当前 API 端口 36360 为新注册项）-> 不重复展示
    const vis = raw.filter((r) => !(r.role === "supervisor-api" && (r.port === 3100 || r.port === 3101)));
    // 排序：激活(监听中)在上，停用在下；组内按端口号升序
    return [...vis].sort((a, b) => {
      if (Boolean(a.active) !== Boolean(b.active)) return a.active ? -1 : 1;
      return a.port - b.port;
    });
  }, [raw]);

  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <CardTitle title="运行状态" subtitle="核心服务与端口实时状态" actions={records ? <span className="font-mono text-xs text-muted-foreground">{records.length} 端口</span> : null} />

      {!records ? (
        <div className="px-5 py-6 text-center text-xs text-muted-foreground">运行状态加载中…</div>
      ) : (
        <div className="min-h-0 overflow-x-auto">
          <div className="grid min-w-[400px] grid-cols-[56px_minmax(0,1fr)_auto_66px] items-center gap-2 border-b border-border/60 bg-muted/60 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span>端口</span><span>服务</span><span className="text-right">归属</span><span className="text-right">状态</span>
          </div>
          <div className="max-h-[340px] overflow-y-auto overscroll-contain">
            {records.map((r, i) => (
              <div key={r.port + "-" + r.owner} className={cn("grid grid-cols-[56px_minmax(0,1fr)_auto_66px] items-center gap-2 px-4 py-2 hover:bg-muted/40", i > 0 && "border-t border-border/50")}>
                <code className="font-mono text-sm tabular-nums text-foreground">{r.port}</code>
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-xs text-foreground">{roleLabel(r)}</span>
                </div>
                <div className="flex justify-end"><Pill tone={roleTone(r.role, r.owner)}>{resolveOwner(r, providers)}</Pill></div>
                <div className="flex justify-end">
                  {r.active === true ? (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-status-ok"><CircleDot className="size-3" />运行中</span>
                  ) : r.active === false ? (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground"><CircleDot className="size-3 opacity-50" />未运行</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground"><CircleDot className="size-3 opacity-40" />状态未知</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
