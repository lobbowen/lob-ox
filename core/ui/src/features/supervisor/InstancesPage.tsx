/**
 * 实例管理（supervisor）：数据经 supervisorStore.instances（统一 2s 快照），
 * 动作 supervisorApi.instance* -> refresh()。
 */
import { useEffect, useState } from "react";
import {
  Activity, Box, ExternalLink, Power, Rocket, RotateCw, ShieldCheck, Square, Trash2, TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "../../framework/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../../framework/ui/dialog";
import { useConfirm } from "../../framework/ui/confirm";
import { Input } from "../../framework/ui/input";
import { Textarea } from "../../framework/ui/textarea";
import { Label } from "../../framework/ui/label";
import { Spinner } from "../../framework/ui/spinner";
import { supervisorApi, supervisorStore, useSupervisorData, type SupervisorInstance } from "../../services/supervisor";
import { useSupervisorAction } from "./useSupervisorAction";
import { runOpenExternal } from "./openExternal";
import { DomainBadge, Metric, Pill, Card, ToneDot } from "./widgets";
import { friendlyFailure, instancePhaseMeta } from "./nav";
import { cn } from "../../framework/utils";

export function InstancesPage({ onRegisterActions }: { onRegisterActions?: (a: { onAdd: () => void } | null) => void }) {
  const { snap } = useSupervisorData();
  const { busy: busyId, run } = useSupervisorAction();
  const askConfirm = useConfirm();
  const [addOpen, setAddOpen] = useState(false);

  const [fName, setFName] = useState("");
  const [fPort, setFPort] = useState("");
  const [fCmd, setFCmd] = useState("");

  // /instances 已拆分：instances[] 即沙箱；原生主干在 native 字段（由 Overview 主干卡呈现）
  const items = snap.instances?.instances ?? [];
  // /env/status.capabilities 分字段暴露：sandboxLaunch=能否跑舱，sandboxEnforcement=限额由谁执行；
  // 不支持时前置提示，不等用户点「添加」被后端 400 拒绝才知道
  const [caps, setCaps] = useState<{ sandboxLaunch?: boolean; sandboxEnforcement?: string; platform?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    supervisorApi.envStatus().then((r) => { if (alive) setCaps(r.capabilities ?? null); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const sandboxUnsupported = caps !== null && caps.sandboxLaunch === false;
  // W3 档位：三平台均可跑舱；supervise 软限（采样式治理、无内核强制）不拦功能，只如实标注语义。
  // 能力未回读（caps=null）时档位句一律不说——宁可少讲，不谎报硬限。
  const softTier = caps?.sandboxEnforcement === "supervise";
  const tierLabel = caps == null ? null
    : caps.sandboxEnforcement === "cgroup" ? "cgroup 内核硬限"
      : softTier ? "采样式软限（超限由守卫按拍数收割重启，非内核级强制）"
        : "无内核级限额";

  // 顶部 Toolbar 动作注册：点击打开本页 dialog
  useEffect(() => {
    onRegisterActions?.({ onAdd: () => setAddOpen(true) });
    return () => onRegisterActions?.(null);
  }, [onRegisterActions]);

  /** 动作（busy 键 = 实例 id；操作静默成功，仅刷新快照） */
  const act = (key: string, fn: () => Promise<unknown>) => run(key, fn);

  // DSH Web 的成败与地址由 notifyOpen 呈现（三档语义 + 可复制地址），run 只负责按钮忙碌态，
  // 故把返回值置空：不让 run 的通用「{ok:false} 即失败」判据再叠一条丢失地址的错误条。
  const openWeb = (id: string) => run(id, () => runOpenExternal(() => supervisorApi.instanceOpenWeb(id)).then(() => undefined));

  async function addInstance() {
    if (sandboxUnsupported) { toast.error("当前平台不支持沙箱实例（见 /env/status 能力矩阵）"); return; }
    const port = parseInt(fPort, 10);
    if (!Number.isFinite(port) || port <= 0) { toast.error("请填写有效端口"); return; }
    const command = fCmd ? fCmd.split(/\n/).map((x) => x.trim()).filter(Boolean) : [];
    try {
      const r = await supervisorApi.instanceAdd({ name: fName.trim() || ("沙箱 " + port), port, command });
      if (r && r.ok === false) { toast.error(r.error || "添加失败"); return; }
      toast.success("已添加实例");
      setAddOpen(false);
      setFName(""); setFPort(""); setFCmd("");
      supervisorStore.refresh();
    } catch (e) { toast.error(String(e)); }
  }

  async function checkUpdate(it: SupervisorInstance) {
    // 分支反馈（发现新版/已最新/失败）留在动作内；busy 与刷新由共享 run 管理
    await run(it.id, async () => {
      const r = await supervisorApi.instanceCheckUpdate(it.id);
      if (r.updateAvailable) { toast.success("发现新版 " + r.latest + "，可点「更新」升级"); setUpdOk((m) => new Map(m).set(it.id, true)); }
      else if (r.latest) toast.info("已是最新 " + r.latest);
      else toast.error(r.error || "版本检测失败");
    });
  }
  const [updOk, setUpdOk] = useState<Map<string, boolean>>(new Map());

  async function upgrade(it: SupervisorInstance) {
    if (!(await askConfirm({
      title: "升级该沙箱实例的 DSH 到最新版？",
      description: "实例会短暂重启，进行中的请求中断。",
      confirmText: "升级",
    }))) return;
    await run(it.id, () => supervisorApi.instanceUpgrade(it.id), { success: "升级已开始…" });
  }

  /** 删除实例：不可恢复，走统一确认出口。 */
  async function removeInstance(it: SupervisorInstance) {
    if (!(await askConfirm({
      title: "删除实例「" + it.name + "」？",
      description: "将彻底删除该沙箱实例（含配置与运行时数据）。此操作不可恢复。",
      confirmText: "删除实例",
      tone: "destructive",
    }))) return;
    // 删除的安全结果必须对用户可见：后端在「单元仍在运行」时保留数据目录（防不可逆丢失）
    //并返回 dataPreserved=true，须如实说明，否则等于谎报「数据已清」。
    await run(it.id, async () => {
      const r = await supervisorApi.instanceRemove(it.id);
      if (r && r.ok !== false && r.dataPreserved === true) {
        toast.warning("实例已移除，但因其单元仍在运行，数据目录已保留（未删除）——请先停止实例再删数据");
      } else if (r && r.ok === false) {
        toast.error(r.error || "删除失败");
      }
      supervisorStore.refresh();
    });
  }

  const InstanceRow = ({ it }: { it: SupervisorInstance }) => {
    const running = it.state?.running ?? false;
    const lp = it.state?.lifecyclePhase;
    const pm = instancePhaseMeta(lp, running);
    const upd = it.updateJob;
    const updating = upd?.state === "running";
    const mem = it.state?.allocation?.memoryMax || "—";
    const cpu = it.state?.allocation?.cpuQuota || "—";
    // 实测占用（监督拍采样回填；停止/未采到为 null，与配额成对展示，绝不以零充数）
    const usage = it.state?.usage;
    const uMem = usage && typeof usage.memMb === "number" ? usage.memMb : null;
    const uCpu = usage && typeof usage.cpuPct === "number" ? usage.cpuPct : null;
    const busy = busyId === it.id;
    return (
      <Card className="overflow-visible">
        {/* 信息区：左（身份/状态） / 右（资源指标） */}
        <div className="grid grid-cols-1 @min-[720px]:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <div className="flex flex-col gap-4 border-b border-border px-6 py-5 md:border-b-0 md:border-r">
            {/* 身份行 */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <strong className="truncate text-lg font-semibold tracking-[-0.01em] text-foreground">{it.name}</strong>
                {it.version ? (
                  <span className="font-mono text-sm text-muted-foreground">v{it.version}</span>
                ) : null}
              </div>
              {/* 版本检测/更新（随状态演化） */}
              {updOk.get(it.id) ? (
                <Button className="text-primary-foreground" onClick={() => void upgrade(it)} size="chip">
                  <RotateCw className="size-3" />更新
                </Button>
              ) : (
                <Button className="bg-primary/10 text-primary hover:bg-primary/15" disabled={busy || updating} onClick={() => void checkUpdate(it)} size="chip" variant="ghost">
                  <RotateCw className={cn("size-3", busy && "animate-spin")} />检测更新
                </Button>
              )}
            </div>

            {/* 运行状态 */}
            <div className="flex flex-wrap items-center gap-2">
              <ToneDot tone={pm.tone} ping={pm.tone === "ok"} />
              <span className="text-base font-semibold leading-none text-foreground">{pm.label}</span>
            </div>

            {/* 升级/安装进度 */}
            {updating ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3" />
                正在升级 DeepSeek Harness（{upd?.step || ""}）…
              </div>
            ) : null}
            {it.state?.installing ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3" />正在安装…
              </div>
            ) : null}
            {lp === "FAILED" ? (
              <div className="flex items-center gap-1.5 text-xs text-destructive">
                <TriangleAlert className="size-3.5" />
                <span className="truncate">{it.state?.lastError || "失败"}</span>
              </div>
            ) : null}
          </div>

          {/* 右：运行指标（与原生主卡一致：端口/PID/重启次数/最近故障） */}
          <div className="flex items-center bg-[image:var(--panel-accent-gradient)] px-6 py-5">
            <div className="grid w-full grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              <Metric icon={<Activity className="size-4" />} label="端口" value={String(it.port)} mono />
              <Metric icon={<Square className="size-4" />} label="PID" value={it.state?.pid ? String(it.state.pid) : "—"} mono />
              <Metric icon={<RotateCw className="size-4" />} label="重启次数" value={String(it.state?.restartCount ?? 0)} mono />
              <Metric icon={<TriangleAlert className="size-4" />} label="最近故障" value={it.state?.lastFailure ? friendlyFailure(it.state.lastFailure) : "无"} warn={Boolean(it.state?.lastFailure)} />
            </div>
          </div>
        </div>

        {/* 底栏操作行：左信息（环境检测位 -> 内存/CPU）/ 右操作 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-6 py-3">
          {/* 左信息(沙箱/远程/内存CPU)——窄屏(内容区<860px)隐藏, 位置让给右侧操作按钮 */}
          <span className="hidden min-w-0 items-center lg:inline-flex gap-2 text-xs text-muted-foreground">
            <DomainBadge domain="sandbox" />
            <Pill tone={it.remoteMode && it.remoteMode !== "off" ? "boot" : "off"}>{it.remoteMode === "wan" ? "远程·公网" : it.remoteMode === "lan" ? "远程·局域网" : "远程关闭"}</Pill>
            <span className="whitespace-nowrap" title={"配额由守卫按机器预算与活跃实例数动态推导" + (tierLabel ? "；执行档位：" + tierLabel : "")}>
              配额 内存 {mem} · CPU {cpu}{softTier ? "（软限）" : ""}
            </span>
            {uMem === null && uCpu === null ? null : (
              <span className="whitespace-nowrap" title="监督拍实测值（最近一次采样；停止或未采到不显示）">
                占用 {uMem === null ? "—" : `${uMem}MB`}{uCpu === null ? "" : ` · CPU ${Math.round(uCpu)}%`}
              </span>
            )}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button disabled={!running} onClick={() => void openWeb(it.id)} size="sm" title="打开 DSH Web（自动带认证连接）" variant="outline" className="hidden md:inline-flex">
              <ExternalLink className="size-4" />DSH Web
            </Button>
            <Button disabled={updating} onClick={() => void act(it.id, () => (running ? supervisorApi.instanceStop(it.id) : supervisorApi.instanceStart(it.id)))} size="sm" variant="outline">
              {running ? <><Power className="size-4 text-status-error" />停止实例</> : <><Rocket className="size-4 text-primary" />启动实例</>}
            </Button>
            {/* 分割线(启停后) -> 进程守护按钮(与主 DSH 卡同布局) */}
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
            <Button disabled={busy} onClick={() => void act(it.id, () => supervisorApi.instanceUpdate(it.id, { guardian: !it.guardian }))} size="sm" variant="outline">
              <ShieldCheck className={cn("size-4", it.guardian ? "text-status-ok" : "text-muted-foreground")} />
              {it.guardian ? "停止守护" : "启动守护"}
            </Button>
            {/* 守护后无分割线(用户定稿, 与主 DSH 卡一致); 窄屏隐藏(只留启停+守护) */}
            <Button className="hidden h-[30px] md:inline-flex" disabled={busy} onClick={() => void removeInstance(it)} size="sm" variant="destructive">
              <Trash2 className="size-4" />删除
            </Button>
          </div>
        </div>
      </Card>
    );
  };

  return (
    <div className="grid content-start gap-4">
      {/* A1：平台能力前置提示——不支持的平台直接说明原因（无需等后端报错） */}
      {sandboxUnsupported ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <span>
            当前平台（{caps?.platform || "未知"}）不支持沙箱实例（能力矩阵见 /env/status 的 capabilities.sandboxLaunch；限额执行档位见 capabilities.sandboxEnforcement）。
            原生 DSH 主实例不受影响。
          </span>
        </div>
      ) : null}
      {!items.length ? (
        <div className="grid min-h-[220px] place-items-center rounded-lg border border-dashed border-border text-center">
          <div>
            <Box className="mx-auto mb-3 size-8 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">尚未添加沙箱实例</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {sandboxUnsupported ? "当前平台不支持沙箱实例（见上方说明）" : "点击顶部「添加实例」创建沙箱"}
            </p>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">{items.map((it) => <InstanceRow key={it.id} it={it} />)}</div>
      )}

      {/* 添加实例 */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-[440px]">
          <DialogHeader><DialogTitle>添加 DSH 实例</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>实例名称</Label>
              <Input placeholder="如 沙箱二开" value={fName} onChange={(e) => setFName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>监听端口</Label>
              <Input inputMode="numeric" placeholder="如 3082" value={fPort} onChange={(e) => setFPort(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>启动命令（每项一参数，可留空用默认）</Label>
              <Textarea
                className="min-h-[72px] font-mono text-sm"
                placeholder={"node\n/usr/local/bin/dsh\nweb"}
                value={fCmd}
                onChange={(e) => setFCmd(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              内存/CPU 配额无需填写：启动时由守卫按机器预算与活跃实例数自动推导，实例增减后动态重分配。
              {tierLabel ? ` 执行档位：${tierLabel}。` : ""}
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setAddOpen(false)} variant="outline">取消</Button>
            <Button onClick={() => void addInstance()}>添加</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
