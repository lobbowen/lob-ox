import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "../../../framework/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../../framework/ui/dialog";
import { useConfirm } from "../../../framework/ui/confirm";
import { supervisorApi } from "../../../services/supervisor";
import { hasShellHost, requestKernelUpdate, type KernelUpdateProgress } from "../../../services/supervisor/kernelUpdateBridge";
import { useSupervisorAction } from "../useSupervisorAction";
import { Card, CardTitle, Pill } from "../widgets";
import { cn } from "../../../framework/utils";

type VerInfo = {
  version?: string;
  installed?: string;
  latest?: string;
  updateAvailable?: boolean;
  ok?: boolean;
  error?: string | null;
  upstream?: string;
  commit?: string;
};

type ShellInfo = {
  version?: string | null;
  latest?: string | null;
  updateAvailable?: boolean;
  capable?: boolean;
  installKind?: string;
  error?: string | null;
};

const PRODUCT_NAME = "DeepSeek Harness 管家";
const PRODUCT_DESC =
  "独立于 Harness 运行的系统级守卫：负责启动、存活监测与故障自动重启被监管目标，" +
  "提供生命周期管理、智能路由、远程控制与多实例沙箱的运维面板。";

const fmt = (s?: string | null) => (s ? String(s).replace(/^v/i, "") : "—");

export function AboutCard() {
  const [ver, setVer] = useState<VerInfo | null>(null);
  const [shell, setShell] = useState<ShellInfo | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [logKind, setLogKind] = useState<"dsh" | "guard">("dsh");
  const [logText, setLogText] = useState("");
  // 壳中继的安装进度：否则界面长时间静止，用户重试会并发写同一 npm 全局包。
  const [coreProg, setCoreProg] = useState<KernelUpdateProgress | null>(null);
  const { busy, run } = useSupervisorAction();
  const askConfirm = useConfirm();

  const openLog = useCallback(async (kind: "dsh" | "guard") => {
    setLogKind(kind);
    setLogText("");
    setLogOpen(true);
    try {
      const text = kind === "dsh" ? await supervisorApi.dshChangelog() : await supervisorApi.guardChangelog();
      setLogText(text || "（无内容）");
    } catch (e) {
      setLogText("加载失败：" + String(e));
    }
  }, []);

  const load = useCallback(async () => {
    const [core, sh] = await Promise.all([
      supervisorApi.guardVersion().catch(() => null),
      supervisorApi.shellStatus().catch(() => null),
    ]);
    setVer(core || {});
    setShell(sh ? {
      version: sh.identity?.version || null,
      capable: sh.identity?.selfUpdateCapable === true,
      installKind: sh.identity?.installKind,
    } : {});
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [core, sh] = await Promise.all([
        supervisorApi.selfUpdateStatus().catch(() => null),
        supervisorApi.shellCheckUpdate().catch(() => null),
      ]);
      if (!alive) return;
      if (core && core.ok !== false) setVer((prev) => ({ ...(prev || {}), ...core }));
      if (sh) setShell((prev) => ({ ...(prev || {}), latest: sh.latest || null, updateAvailable: sh.updateAvailable === true, error: sh.error || null }));
    })();
    return () => { alive = false; };
  }, []);

  const check = async () => {
    await run("chk", async () => {
      let coreMsg = "内核：状态未知";
      const r = await supervisorApi.selfUpdateStatus().catch(() => null);
      if (r && r.ok !== false) {
        setVer(r || {});
        coreMsg = r.updateAvailable && r.latest
          ? "内核有新版本 " + fmt(r.latest) + "（当前 " + fmt(r.installed) + "）"
          : "内核已是最新（" + fmt(r.installed) + "）";
      } else {
        const local = await supervisorApi.guardVersion().catch(() => null);
        if (local?.upstream === "git-repo") {
          const g = await supervisorApi.guardVersionCheck().catch(() => null);
          setVer({ ...(local || {}), ...(g || {}) });
          coreMsg = g?.updateAvailable
            ? "内核源码仓库有上游更新（当前提交 " + (g.commit || local?.commit || "—") + "）"
            : "内核源码仓库已是最新（提交 " + (local?.commit || g?.commit || "—") + "）";
        } else {
          coreMsg = "内核：" + ((r && r.error) || "自更新未配置");
        }
      }
      const sh = await supervisorApi.shellCheckUpdate().catch(() => null);
      let shellMsg = "桌面壳：状态未知";
      if (sh && sh.ok !== false) {
        setShell((prev) => ({ ...(prev || {}), latest: sh.latest || null, updateAvailable: sh.updateAvailable === true, error: null }));
        shellMsg = sh.updateAvailable && sh.latest
          ? "桌面壳有新版本 " + fmt(sh.latest) + "（当前 " + fmt(sh.installed) + "）"
          : "桌面壳已是最新（" + fmt(sh.installed) + "）";
      } else {
        setShell((prev) => ({ ...(prev || {}), error: (sh && sh.error) || "检测失败" }));
        shellMsg = "桌面壳：" + ((sh && sh.error) || "检测失败");
      }
      const anyUpdate = Boolean((r?.updateAvailable && r?.latest) || (sh?.updateAvailable && sh?.latest));
      if (anyUpdate) toast.warning(coreMsg + "；" + shellMsg);
      else toast.success(coreMsg + "；" + shellMsg);
    }, { refresh: false });
  };

  // 内核更新唯一写入者 = 桌面壳，经消息桥 kernel_update_apply 执行。
  const applyCoreUpdate = async () => {
    if (!hasShellHost()) { toast.error("内核更新由桌面壳执行：请在桌面壳面板中操作。"); return; }
    if (!(await askConfirm({
      title: "发现内核新版本 " + fmt(ver?.latest) + "，是否立即更新？",
      description: "内核将由桌面壳安装，并自动重启守卫。",
      confirmText: "更新",
    }))) return;
    await run("upd", async () => {
      setCoreProg({ status: "已向桌面壳发出更新请求，等待响应…" });
      const r = await requestKernelUpdate(setCoreProg);
      if (!r.ok) { toast.error(r.error || "更新失败"); return; }
      const v = fmt(r.version || ver?.latest);
      if (r.restartUncertain) toast.warning("内核已更新至 " + v + "，但守卫可能未自动重启，请手动确认。");
      else toast.success("内核已更新至 " + v + "，守卫已重启。");
    }, { refresh: true, onDone: () => setCoreProg(null) });
  };


  const coreUpdate = Boolean(ver?.updateAvailable && ver?.latest && ver.latest !== ver?.installed);
  const shellUpdate = Boolean(shell?.updateAvailable && shell?.latest && shell.latest !== shell?.version);
  const shellUncapable = shell?.capable === false;

  return (
    <Card>
      <CardTitle
        title="关于"
        subtitle={PRODUCT_NAME}
        actions={
          <Button size="sm" disabled={busy === "chk"} onClick={() => void check()} variant="outline">
            <RefreshCw className={cn("size-3.5", busy === "chk" && "animate-spin")} />
            检查更新
          </Button>
        }
      />
      <div className="grid gap-3 px-5 py-4">
        <div className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-3">
          <span className="text-xs text-muted-foreground">桌面壳版本</span>
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
            {fmt(shell?.version)}
            {shell?.installKind ? <span className="text-xs font-normal text-muted-foreground">（{shell.installKind}）</span> : null}
            {shellUpdate ? (
              <>
                <Pill tone="warn">可更新 {fmt(shell?.latest)}</Pill>
                <Pill tone="off">请重启桌面壳应用更新</Pill>
              </>
            ) : null}
            {shellUncapable ? <Pill tone="off">当前形态不支持自更新</Pill> : null}
            {shell?.error ? <span className="text-xs font-normal text-muted-foreground">{shell.error}</span> : null}
          </span>
        </div>
        <div className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-3">
          <span className="text-xs text-muted-foreground">内核版本</span>
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
            {fmt(ver?.installed || ver?.version)}
            {coreUpdate ? (
              <>
                <Pill tone="warn">可更新 {fmt(ver?.latest)}</Pill>
                {hasShellHost() ? (
                  <Button size="chip" disabled={busy === "upd"} onClick={() => void applyCoreUpdate()} variant="outline">
                    <RefreshCw className={cn("size-3", busy === "upd" && "animate-spin")} />更新
                  </Button>
                ) : (
                  <Pill tone="off">请在桌面壳中更新</Pill>
                )}
              </>
            ) : null}
          </span>
        </div>
        {coreProg ? (
          <div className="flex flex-wrap items-center gap-2 text-xs leading-relaxed text-muted-foreground">
            <RefreshCw className="size-3 shrink-0 animate-spin" />
            <span className="min-w-0 flex-1 break-words">{coreProg.status || "桌面壳处理中…"}</span>
            {typeof coreProg.progress === "number"
              ? <span className="tabular-nums font-medium text-foreground">{Math.round(coreProg.progress * 100)}%</span>
              : null}
          </div>
        ) : null}
        <p className="border-t border-border/60 pt-3 text-xs leading-relaxed text-muted-foreground">
          {PRODUCT_DESC}
        </p>
        <div className="flex items-center gap-2 border-t border-border/60 pt-3">
          <Button size="chip" variant="outline" onClick={() => void openLog("dsh")}>
            DSH 更新日志
          </Button>
          <Button size="chip" variant="outline" onClick={() => void openLog("guard")}>
            管家更新日志
          </Button>
        </div>
      </div>
      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{logKind === "dsh" ? "DeepSeek Harness 更新日志" : "管家更新日志"}</DialogTitle>
          </DialogHeader>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed text-foreground">
            {logText || "加载中…"}
          </pre>
        </DialogContent>
      </Dialog>
    </Card>
  );
}