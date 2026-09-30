// 远程控制三态页（关闭 / 局域网 / 公网）。模式写入唯一经 /remote/set-mode；就绪与 accessUrl 一律直消费
// 后端 remote 单一视图，前端零推导。访问令牌由后端在开启远程时补齐，明文只随回环来源下发（本机可看可改，
// 且本机有明文时二维码直接带一次性出示，扫码即用）。
// FRP 卡只管 frps 连接配置，无总闸：frpc 常驻与否 = 是否存在公网模式实例。
import { useEffect, useState } from "react";
import { ExternalLink, Eye, EyeOff, Globe, KeyRound, Landmark, Save, Wrench } from "lucide-react";
import { toast } from "sonner";
import QRCode from "react-qr-code";
import { Button, Switch } from "../../framework/ui";
import { useConfirm } from "../../framework/ui/confirm";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../framework/ui/dialog";
import { Input } from "../../framework/ui/input";
import { Label } from "../../framework/ui/label";
import { supervisorApi, useSupervisorData } from "../../services/supervisor";
import type { LanItem, RemoteMode, RemoteView } from "../../services/supervisor/types";
import { useSupervisorAction } from "./useSupervisorAction";
import { runOpenExternal } from "./openExternal";
import { handOffFromPanel } from "../../services/supervisor/externalOpen";
import { Card, CardTitle, DomainBadge, Pill } from "./widgets";

import { cn } from "../../framework/utils";

/** 后端视图条目缺失时的兜底（mode 非 off 但 relay 自愈未落拍）：如实呈现未就绪，不假装就绪。 */
const fallbackView = (mode: RemoteMode): RemoteView =>
  ({ mode, ready: false, accessUrl: null, reasons: ["远程服务未就绪"] });

export function LanPage() {
  const { snap } = useSupervisorData();
  const { busy, run } = useSupervisorAction();
  // 远程控制是横切能力：主干(main, native 字段)与沙箱(instances[])都是可远程的受管 DSH。
  const instances = [
    ...(snap.instances?.native ? [snap.instances.native] : []),
    ...(snap.instances?.instances ?? []),
  ];
  const lanItems = snap.lan?.items ?? [];
  const frp = snap.frp;

  // FRP 表单（只在数据加载后填充一次）
  const [frpAddr, setFrpAddr] = useState("");
  const [frpPort, setFrpPort] = useState("7000");
  const [frpToken, setFrpToken] = useState("");
  const [loaded, setLoaded] = useState(false);
  // 令牌对话框带上打开时刻的现值（本机可见即明文可改）
  const [tokenFor, setTokenFor] = useState<{ id: string; name?: string; current: string | null } | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenVisible, setTokenVisible] = useState(false);
  const askConfirm = useConfirm();
  useEffect(() => {
    if (!frp || loaded) return;
    setFrpAddr(frp.settings.serverAddr || "");
    setFrpPort(String(frp.settings.serverPort || 7000));
    // /remote/frp 不回显 authToken（仅 authTokenSet 布尔）——不回填、不显示；轮换经输入框完成
    setLoaded(true);
  }, [frp, loaded]);

  /** 提交体组装（patch 语义）：authToken 留空必须整体省略——显式提交 '' 会被后端当作清除落盘。 */
  function frpPayload() {
    const p: { serverAddr: string; serverPort: number; authToken?: string } = {
      serverAddr: frpAddr, serverPort: parseInt(frpPort, 10) || 7000,
    };
    const t = frpToken.trim();
    if (t) p.authToken = t;
    return p;
  }

  /** 模式写入唯一动作（off|lan|wan）；安全闸拒因（如令牌过短）由 run 统一 toast 呈现。
   *  后端在开启时补齐缺失令牌 = 凭空多出一条凭据，用户必须被告知去哪看，故按回执补一条提示。 */
  async function setMode(it: { id: string; name?: string }, mode: RemoteMode, success: string) {
    let allocated = false;
    const ok = await run(it.id, () => supervisorApi.remoteSetMode(it.id, mode).then((r) => {
      allocated = r?.tokenAutoAllocated === true;
      return r;
    }), { success });
    if (ok && allocated) toast.info("已自动生成访问令牌，点钥匙按钮可查看或修改");
    return ok;
  }
  /** 开启远程控制（off->lan）：高危，经统一确认出口。缺访问令牌时后端在写入处补齐。 */
  async function askOn(it: { id: string; name?: string }) {
    if (!(await askConfirm({
      title: "开启远程控制？",
      description: "「" + (it.name || it.id) + "」将开启局域网反向代理，同网段设备可访问该实例"
        + "（无访问令牌时自动生成一个，可在钥匙按钮处查看）。",
      confirmText: "开启远程控制",
    }))) return;
    await setMode(it, "lan", "已开启远程控制（局域网）");
  }
  /** 切公网：高危确认（互联网可触达）；令牌前置由后端 wan 闸裁决，拒因如实提示。 */
  async function askWan(it: { id: string; name?: string }) {
    if (!(await askConfirm({
      title: "切换到公网访问？",
      description: "「" + (it.name || it.id) + "」的访问端口将映射到公网（frps），互联网上任何人都可尝试触达"
        + "（访问令牌是硬性前置，缺失时自动生成）。",
      confirmText: "切换到公网",
    }))) return;
    await setMode(it, "wan", "已切换到公网访问");
  }
  /** 打开「设置访问令牌」对话框。current 为 null 表示本机看不到明文（远程访客面板），退化为只写不读。 */
  function setToken(it: { id: string; name?: string }, current: string | null) {
    setTokenInput(current ?? "");
    setTokenVisible(false);
    setTokenFor({ id: it.id, name: it.name, current });
  }
  async function submitToken() {
    const it = tokenFor;
    if (!it) return;
    const v = tokenInput.trim();
    if (!v) { toast.error("令牌不能为空"); return; }
    // 与守卫写入口同规（remoteToken 至少 8 位），先行提示避免提交后才见服务端拒因
    if (v.length < 8) { toast.error("远程访问令牌至少 8 位（公网暴露可被暴力枚举）"); return; }
    setTokenFor(null);
    // 预填值原样提交 = 用户只是看了一眼地址，不必再落一次盘（也不触发 relay 令牌热换与事件）
    if (it.current !== null && it.current === v) return;
    await run(it.id, () => supervisorApi.remoteSetToken(it.id, v), { success: "访问令牌已设置" });
  }
  async function saveFrp() {
    await run("frp-save", () => supervisorApi.remoteFrpServer(frpPayload()), { success: "已保存 FRP 配置" });
  }

  return (
    <div className="grid content-start gap-4">
      <div className="grid items-start gap-4 @min-[900px]:grid-cols-[minmax(0,1fr)_420px]">
      <Card>
        <CardTitle title="远程控制" subtitle="为本地 DSH 实例开启远程访问：局域网直连或经 FRP 公网（需实例运行中）" />
        <div className="grid">
          {!instances.length ? (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">暂无实例（在「实例管理」添加后将出现在这里）</div>
          ) : instances.map((it) => {
            const running = it.state?.running ?? false;
            const proxy: LanItem | undefined = lanItems.find((p) => p.dshPort === it.port);
            const mode: RemoteMode = it.remoteMode ?? "off";
            const remote = mode === "off" ? null : (proxy?.remote ?? fallbackView(mode));
            // accessUrl 与 ready 正交（后端 projectRemoteView 已分开给出）：地址已定即呈现为可点/可复制的一行，
            // 未就绪也要让用户看见要访问什么；二维码只表达「现在扫得开」，故仍跟 ready。
            const url = remote?.accessUrl ?? null;
            // 令牌明文只有本机（回环）面板拿得到；有明文就把一次性出示编进码内，否则扫码落在 401 提示页，
            // 「扫得开」就成了空话。访客面板无明文，码里也就只有裸地址——呈现形态放宽，可达面未放宽。
            const token = typeof it.remoteToken === "string" && it.remoteToken.trim() ? it.remoteToken.trim() : null;
            const qr = remote?.ready && url ? (token ? url + "?token=" + encodeURIComponent(token) : url) : null;
            // 钥匙态：本机直读实例意图字段（远程关闭的实例同样有值），远程访客无该字段、退回 relay 布尔。
            const tokenSet = token !== null || !!proxy?.tokenSet;
            const remotePill = mode === "off"
              ? <Pill tone="off">远程关闭</Pill>
              : remote?.ready
                ? <Pill tone={mode === "wan" ? "boot" : "ok"}>{mode === "wan" ? "公网就绪" : "局域网就绪"}</Pill>
                : <span title={(remote?.reasons ?? []).join("；")}><Pill tone="off">远程停止</Pill></span>;
            return (
              <div key={it.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-stretch gap-4 border-b border-border/60 px-5 py-4 last:border-b-0">
                {qr ? (
                  <div className="flex shrink-0 items-center rounded-lg border border-border bg-white p-1.5"
                    title={token ? "扫码访问该实例远程地址（已带访问令牌，一次出示后凭 Cookie）" : "扫码访问该实例远程地址"}>
                    <QRCode value={qr} size={88} />
                  </div>
                ) : (
                  <div className="grid size-[96px] shrink-0 place-items-center rounded-lg border border-dashed border-border/70 text-center text-[11px] leading-tight text-muted-foreground/60">
                    {running ? (mode === "off" ? "开启远程后生成二维码" : "远程就绪后生成二维码") : "启动后可用"}
                  </div>
                )}
                <div className="flex min-w-0 flex-col">
                  <div className="pt-2.5 flex flex-wrap items-center gap-2">
                    <DomainBadge domain={it.domain} />
                    <strong className="truncate text-sm font-semibold text-foreground">{it.name}</strong>
                    {remotePill}
                  </div>
                  <div className="mt-auto grid content-end gap-1.5 pb-1">
                    <div className="text-xs text-muted-foreground">
                      端口 {it.port}{mode !== "off" && proxy?.wanPort ? " · 访问端口 " + proxy.wanPort + (mode === "wan" ? "（公网同号）" : "") : ""}
                    </div>
                    {url ? (
                      <button type="button" onClick={() => void runOpenExternal(() => handOffFromPanel(url))}
                        className="inline-flex max-w-full items-center gap-1 truncate text-xs text-primary hover:underline"
                        title={token ? "令牌绝不进浏览器启动参数，故直接打开需自行附加 ?token=；扫码可直达" : "在系统浏览器中打开该地址"}>
                        <ExternalLink className="size-3 shrink-0" />{url}
                      </button>
                    ) : !running || mode === "off" ? (
                      <div className="text-xs text-muted-foreground/70">
                        {!running ? "实例未运行，启动后可开启远程" : "远程未开启"}
                      </div>
                    ) : null}
                    {/* 未就绪的原因与地址行并存：地址是「去哪儿」，原因是「为什么现在还不通」 */}
                    {remote && !remote.ready ? (
                      <div className="text-xs text-muted-foreground/70">
                        {(remote.reasons ?? []).slice(0, 2).join("；") || "等待代理分配访问地址…"}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-col items-end justify-center gap-2">
                  <div className={cn("flex items-center gap-2", !running && "pointer-events-none opacity-50")}>
                    <span className="text-xs font-medium text-muted-foreground">远程控制</span>
                    <Switch
                      checked={mode !== "off"}
                      disabled={!running || busy === it.id}
                      onCheckedChange={(v) => {
                        if (!v) { void setMode(it, "off", "已关闭远程控制"); return; }
                        void askOn(it);
                      }}
                    />
                  </div>
                  {/* 局域网与公网共用同一 relay 端口，只差一条 frpc 隧道 */}
                  {mode !== "off" && (
                    <div className={cn("flex items-center gap-1", (!running || busy === it.id) && "pointer-events-none opacity-50")}>
                      <Button
                        className="h-7 px-2 text-xs" size="chip"
                        variant={mode === "lan" ? "default" : "outline"}
                        title="局域网反向代理访问（同网段）"
                        onClick={() => { if (mode !== "lan") void setMode(it, "lan", "已切换到局域网访问"); }}
                      >
                        <Landmark className="size-3.5" />局域网
                      </Button>
                      <Button
                        className="h-7 px-2 text-xs" size="chip"
                        variant={mode === "wan" ? "default" : "outline"}
                        title={frp?.settings?.serverAddr ? "经 FRP 暴露到公网（需访问令牌）" : "需先在右侧配置 frps 服务器地址"}
                        onClick={() => { if (mode !== "wan") void askWan(it); }}
                      >
                        <Globe className="size-3.5" />公网
                      </Button>
                    </div>
                  )}
                  {/* 访问令牌：开启远程时由后端补齐，这里查看/修改。意图字段与实例是否在跑无关，故不加 running 门。 */}
                  <Button
                    className="h-7 px-1.5"
                    disabled={busy === it.id}
                    onClick={() => void setToken(it, token)}
                    size="chip"
                    title={tokenSet
                      ? "访问令牌已设置（点击查看或修改）"
                      : "未设访问令牌：局域网侧同网段可直接访问，公网模式会被安全闸拒绝，点击设置"}
                    variant="outline"
                  >
                    <KeyRound className={cn("size-3.5", tokenSet ? "text-status-ok" : "text-amber-500")} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      {/* 无总闸：frpc 生命周期 = 是否存在公网模式实例 */}
      <Card>
        <CardTitle
          title="公网访问（FRP 内网穿透）"
          subtitle="存在「公网」模式的实例时 frpc 自动常驻并建立隧道"
          actions={<Pill tone={frp?.running ? "ok" : frp?.installed ? "warn" : "off"}>{frp?.running ? "frpc 运行中" : frp?.installed ? "已安装 · 未运行" : "未安装"}</Pill>}
        />
        <div className="grid grid-cols-1 gap-3 px-5 py-4">
          <div className="grid gap-1.5"><Label>frps 地址</Label><Input placeholder="如 1.2.3.4" value={frpAddr} onChange={(e) => setFrpAddr(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label>frps 端口</Label><Input inputMode="numeric" placeholder="7000" value={frpPort} onChange={(e) => setFrpPort(e.target.value)} /></div>
          {/* 服务端不回显 token 明文；留空提交即省略字段=保留现值 */}
          <div className="grid gap-1.5"><Label>auth token</Label><Input type="password" autoComplete="new-password"
            placeholder={frp?.settings?.authTokenSet ? "已设置 · 留空不修改，输入即轮换" : "frps 的 auth.token"}
            value={frpToken} onChange={(e) => setFrpToken(e.target.value)} /></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-4">
          <span className="text-xs text-muted-foreground">
            {frp?.installed ? "" : "需安装 frpc"}{(frp?.instancesExposed?.length ?? 0) > 0 ? " · 公网实例 " + frp?.instancesExposed?.length + " 个" : " · 无公网模式实例"}
          </span>
          <div className="flex items-center gap-2">
            <Button disabled={busy === "frp-inst"} onClick={() => void run("frp-inst", () => supervisorApi.remoteFrpInstall(), { success: "frpc 安装完成" })} variant="outline"><Wrench className="size-4" />安装 frpc</Button>
            <Button disabled={busy === "frp-save"} onClick={() => void saveFrp()}><Save className="size-4" />保存并应用</Button>
          </div>
        </div>
        {frp?.logTail?.length ? (
          <pre className="mx-5 mb-4 max-h-[160px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/70 p-3 font-mono text-xs leading-relaxed text-muted-foreground">{frp.logTail.join("\n")}</pre>
        ) : null}
      </Card>
      </div>

      {/* 令牌对话框：本机（回环）拿得到明文就预填、可原地改；远程访客读不到现值，退化为只写不读。 */}
      <Dialog open={!!tokenFor} onOpenChange={(o) => !o && setTokenFor(null)}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader><DialogTitle>访问令牌{tokenFor?.name ? " · " + tokenFor.name : ""}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            远程访问需携带此令牌：首次在地址后附加 <code className="break-all">?token=令牌</code>（只需一次，之后凭会话 Cookie 访问）。
            {tokenFor?.current == null
              ? "令牌明文只在内核所在机器上下发，当前面板读不到现值——输入即设为新令牌。"
              : "公网模式硬性要求它；此处显示的是当前生效值，改成新值即轮换。"}
          </p>
          <div className="flex items-center gap-1">
            <Input className="flex-1" type={tokenVisible ? "text" : "password"} autoComplete="off"
              placeholder="输入访问令牌" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submitToken(); }} />
            {tokenFor?.current != null && (
              <Button className="h-9 px-2" size="chip" variant="outline" title={tokenVisible ? "隐藏令牌" : "显示令牌"}
                onClick={() => setTokenVisible((v) => !v)}>
                {tokenVisible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </Button>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTokenFor(null)}>取消</Button>
            <Button disabled={!tokenInput.trim() || busy === tokenFor?.id} onClick={() => void submitToken()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
