/**
 * 控制面板（supervisor overview）：数据经 supervisorStore /status + /events + /instances 快照。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowUpRight, ExternalLink, Power, RefreshCw, Rocket,
  ShieldCheck, TerminalSquare, Trash2, TriangleAlert,
} from "lucide-react";
import type { EnvCatalogItem, NodeLtsStatus } from "../../services/supervisor";
import { toast } from "sonner";
import { Button } from "../../framework/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../../framework/ui/dialog";
import { useConfirm } from "../../framework/ui/confirm";
import { formatClockTime } from "./format";
import { supervisorApi, useSupervisorData, type SupervisorEvent } from "../../services/supervisor";
import { Card, CardTitle, Metric, Pill, ToneDot } from "./widgets";
import { cn } from "../../framework/utils";
import { PortPanel } from "./PortPanel";
import { EnvironmentCard } from "./settings/EnvironmentCard";
import { EVENT_LABELS, SUP_PHASE_META, friendlyFailure } from "./nav";
import { useSupervisorAction } from "./useSupervisorAction";
import { runOpenExternal } from "./openExternal";

const NOISE = new Set(["dist_registry_selected", "gui_autostart_changed", "autostart_changed", "lan_panel_changed", "lan_dsh_token_updated"]);

export function OverviewPage() {
  const { snap } = useSupervisorData();
  const { busy, run } = useSupervisorAction();
  const askConfirm = useConfirm();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  // main(原生 DSH) 守护开关
  const [mainGuardian, setMainGuardian] = useState<boolean | null>(null);
  const s = snap.status;
  const native = s?.native;
  const installed = native?.installed ?? false;
  const nstate = native?.state || (installed ? "installed" : "uninstalled");
  const installing = nstate === "installing";
  const uninstalling = nstate === "uninstalling";
  const nBusy = installing || uninstalling;
  const v = s?.version;
  const upg = s?.upgrade;
  const phaseMeta = SUP_PHASE_META[s?.phase ?? ""] ?? { label: s?.phase || "未知", tone: "off" as const };

  // 原生主干不是沙箱实例列表成员：openWeb 固定目标 main（服务端仅打开浏览器，无沙箱语义）
  const running = Boolean(s?.dshPid);
  const upgradeRunning = upg?.state === "running";

  const events = useMemo(() => snap.events.filter((e) => !NOISE.has(e.type)), [snap.events]);

  async function toggleDsh() {
    // 启停统一走 /lifecycle/dsh/start|stop（单一控制路径）
    await run("dsh", () => (running ? supervisorApi.lifecycleStop("dsh") : supervisorApi.lifecycleStart("dsh")), { success: running ? "正在停止 DSH…" : "正在启动 DSH…" });
  }
  /** 停止运行中的主干 DSH 会中断在飞请求，属高危动作：经统一确认出口后再停。 */
  async function stopDsh() {
    if (!(await askConfirm({
      title: "停止 DSH？",
      description: "主干 DeepSeek Harness 正在运行；停止会中断进行中的请求，远程访问同时不可用。",
      confirmText: "停止 DSH",
    }))) return;
    await toggleDsh();
  }
  async function openWeb() {
    // 三档结果与地址一律由 notifyOpen 呈现（run 的通用判据会把「只是交出去了」也报成一条丢地址的错误）
    await run("web", () => runOpenExternal(() => supervisorApi.instanceOpenWeb("main")).then(() => undefined));
  }
  async function checkUpdate() {
    await run("chk", async () => {
      const res = await supervisorApi.nativeCheckUpdate();
      if (res?.ok === false) { toast.error(res.error || "检测失败"); return; }
      if (res?.updateAvailable && res.latest) {
        toast.success("发现新版本 " + res.latest + (res.installed ? "（当前 " + res.installed + "），可一键升级" : ""));
      } else {
        toast.success("已是最新版本" + (res.installed ? "（" + res.installed + "）" : ""));
      }
    });
    // run 已自动 refresh；后端异步推进由 2s 统一心跳呈现，不再加固定延时
  }
  async function upgradeDsh() {
    setUpgradeOpen(false);
    await run("upg", () => supervisorApi.nativeUpgrade(), { success: "升级已开始，请耐心等待…" });
    // 升级为异步任务：状态机经 /status.upgrade 呈现，由 2s 轮询推进
  }
  async function installDsh() {
    if (!(await askConfirm({
      title: "在线安装最新版 DeepSeek Harness？",
      description: "需数分钟，自动适配最快镜像源。",
      confirmText: "安装",
    }))) return;
    await run("inst", () => supervisorApi.nativeInstall(), { success: "开始安装 DeepSeek Harness…" });
  }
  async function uninstallDsh() {
    if (!(await askConfirm({
      title: "彻底卸载 DeepSeek Harness？",
      description: "删除全部文件、数据、缓存与日志，不留残留。",
      confirmText: "卸载 DSH",
      tone: "destructive",
    }))) return;
    await run("uni", () => supervisorApi.nativeUninstall(), { success: "开始卸载…" });
  }

  // main 守护开关读 A 平面真值（instances.native.guardian = dshMainView 持久化源，即时准确）；
  // 不走 /lifecycle/dsh——B 平面由心跳约 5s 同步，打开后立即刷新会读到旧值导致开关弹回。
  useEffect(() => {
    if (!installed) return;
    supervisorApi.instances().then((r2) => {
      const g = r2?.native?.guardian;
      if (typeof g === "boolean") setMainGuardian(g);
    }).catch(() => {});
  }, [installed, s?.dshPid]); // dshPid 变化(启停)后重读，保证开关与状态同步

  async function toggleMainGuardian() {
    // 点击翻转，消费后端返回值即时刷新（与实例页守护按钮同款形态）
    const v = !(mainGuardian === true);
    await run("gu", () => supervisorApi.nativeSettings({ guardian: v }).then((r2) => {
      const g = r2?.main?.guardian;
      if (typeof g === "boolean") setMainGuardian(g);
      return r2;
    }), {
      success: v ? "已开启 DSH 进程守护（崩溃自动拉起）" : "已关闭 DSH 进程守护（崩溃后不再自动拉起）",
      refresh: false,
    });
  }

  const installedVer = installed ? (native?.version || v?.installed || "—") : "—";

  return (
    <div className="grid content-start gap-4">
      {/* 主状态卡 */}
      <Card>
        <div className="grid grid-cols-1 @min-[720px]:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <div className="flex flex-col gap-5 border-b border-border px-6 py-5 md:border-b-0 md:border-r">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-baseline gap-2">
                <h3 className="truncate text-xl font-semibold tracking-[-0.01em] text-foreground">DeepSeek Harness</h3>
                <span className="shrink-0 font-mono text-sm text-muted-foreground">v{installedVer}</span>
              </div>
              {busy === "chk" ? (
                <Button size="chip" disabled>
                  <RefreshCw className="size-3 animate-spin" />检测中…
                </Button>
              ) : v?.updateAvailable && v.latest ? (
                <Button className="text-primary-foreground" size="chip" onClick={() => setUpgradeOpen(true)}>
                  <ArrowUpRight className="size-3" />升级到 v{v.latest}
                </Button>
              ) : upgradeRunning ? (
                <Button size="chip" disabled>
                  <RefreshCw className="size-3 animate-spin" />升级中…
                </Button>
              ) : (
                <Button className="bg-primary/10 text-primary hover:bg-primary/15" onClick={() => void checkUpdate()} size="chip" variant="ghost">
                  <RefreshCw className="size-3" />检测更新
                </Button>
              )}
            </div>

            {nBusy ? (
              <div className="flex items-center gap-2">
                <ToneDot tone="boot" ping />
                <span className="text-base font-semibold leading-none text-foreground">
                  {installing ? "正在安装 DeepSeek Harness…" : "正在卸载 DeepSeek Harness…"}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <ToneDot tone={phaseMeta.tone} ping={phaseMeta.tone === "ok"} />
                <span className="text-base font-semibold leading-none text-foreground">{phaseMeta.label}</span>
              </div>
            )}

            {upgradeRunning && upg ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                正在升级（{upg.step || upg.targetVersion || ""}）…
              </div>
            ) : null}
            {upg?.state === "failed" ? (
              <p className="text-xs text-destructive">升级失败：{upg.lastError || "未知原因"}{upg.rolledBack ? "（已回滚）" : ""}</p>
            ) : null}

            {/* 原生安装进度日志 */}
            {nBusy && (native?.installLog ?? []).length ? (
              <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/70 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
                {(native?.installLog ?? []).slice(-6).join("\n")}
              </pre>
            ) : null}
          </div>

          <div className="flex items-center bg-[image:var(--panel-accent-gradient)] px-6 py-5">
            <div className="grid w-full grid-cols-2 gap-x-6 gap-y-4 @min-[560px]:grid-cols-4">
              <Metric icon={<Activity className="size-4" />} label="端口" value={s?.dshPort ? String(s.dshPort) : "—"} mono />
              <Metric icon={<TerminalSquare className="size-4" />} label="PID" value={s?.dshPid ? String(s.dshPid) : "—"} mono />
              <Metric icon={<RefreshCw className="size-4" />} label="重启次数" value={String(s?.restartCount ?? 0)} mono />
              <Metric icon={<ArrowUpRight className="size-4" />} label="最近故障" value={s?.lastFailure ? friendlyFailure(s?.lastFailure) : "无"} warn={Boolean(s?.lastFailure)} />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-6 py-3">
          {/* 左：环境检测（Node 版本 + LTS 更新提示）——中屏以下(<980px 视口)隐藏, 位置让给右侧按钮 */}
          <div className="hidden lg:block">
            <EnvDetect />
          </div>
          {/* 右：安装/运行操作 + 分隔线 + 危险操作——ml-auto: 左信息隐藏(窄屏)时按钮组靠右对齐 */}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {!installed && !nBusy ? (
              <Button size="sm" disabled={busy === "inst"} onClick={() => void installDsh()}>
                <Rocket className="size-4" />安装 DSH
              </Button>
            ) : installed && !nBusy && !upgradeRunning ? (
              <>
                <Button disabled={!running} onClick={() => void openWeb()} size="sm" variant="outline" className="hidden md:inline-flex">
                  <ExternalLink className="size-4" />DSH Web
                </Button>
                {/* D3-A 定案：主 DSH 由守卫统一自 spawn（始终守护拉起），无「进程守护」开关；
                    运行操作统一白底 outline（卸载 DSH 为唯一高危实色按钮） */}
                <Button disabled={busy === "dsh"} onClick={() => void (running ? stopDsh() : toggleDsh())} size="sm" variant="outline">
                  {running ? <><Power className="size-4 text-status-error" />停止 DSH</> : <><Rocket className="size-4 text-primary" />启动 DSH</>}
                </Button>
                {/* 分割线（自停止/启动 DSH 后开始分割）-> 进程守护按钮（实例页同款按钮式，非 Switch） */}
                <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
                <Button className="h-[30px]" disabled={busy === "gu" || mainGuardian === null} onClick={() => void toggleMainGuardian()} size="sm" variant="outline">
                  <ShieldCheck className={cn("size-4", mainGuardian === true ? "text-status-ok" : "text-muted-foreground")} />
                  {mainGuardian === true ? "停止守护" : "启动守护"}
                </Button>
              </>
            ) : null}
            {installed && !nBusy ? (
              <>
                {/* 守护后无分割线(用户定稿)——守护与危险操作直接相邻 */}
                <Button className="hidden h-[30px] md:inline-flex" disabled={busy === "uni"} onClick={() => void uninstallDsh()} size="sm" variant="destructive">
                  <Trash2 className="size-4" />卸载 DSH
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </Card>

      {/* 下端两栏（对齐环境变量左右结构）：左=事件日志（懒加载）/ 右=端口管理 */}
      <div className="grid items-start gap-4 @min-[860px]:grid-cols-[minmax(0,1fr)_420px]">
        <EventLogPanel events={events} />
        <PortPanel providers={snap.providers?.providers ?? []} />
      </div>

      {/* 升级确认弹窗 */}
      <Dialog open={upgradeOpen} onOpenChange={setUpgradeOpen}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader><DialogTitle>升级 DeepSeek Harness</DialogTitle></DialogHeader>
          <div className="grid gap-3">
            <div className="flex items-center justify-center gap-3 rounded-md bg-muted px-4 py-3">
              <div className="text-center">
                <div className="text-xs text-muted-foreground">当前版本</div>
                <strong className="font-mono text-base text-foreground">{v?.installed || installedVer}</strong>
              </div>
              <ArrowUpRight className="size-4 text-muted-foreground" />
              <div className="text-center">
                <div className="text-xs text-muted-foreground">新版本</div>
                <strong className="font-mono text-base text-primary">{v?.latest || "—"}</strong>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              升级将先停止 DSH、安装新版本后自动拉起（需数分钟）。期间进行中的请求会中断，失败会自动回滚到当前版本。
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setUpgradeOpen(false)} variant="outline">取消</Button>
            <Button disabled={busy === "upg" || upgradeRunning} onClick={() => void upgradeDsh()}>
              {busy === "upg" || upgradeRunning ? "升级中…" : "开始升级"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 环境检测：声明式消费 /env/status 的 catalog 必填项（Node 与 npm 一律同现）；
 *  LTS 线提示取 /env/node-lts（那是 LTS 建议，不是工具链清单）。 */
function EnvDetect() {
  const [node, setNode] = useState<NodeLtsStatus | null>(null);
  const [items, setItems] = useState<Record<string, EnvCatalogItem> | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [n, e] = await Promise.all([
        supervisorApi.nodeLts().catch(() => null),
        supervisorApi.envStatus().catch(() => null),
      ]);
      if (!alive) return;
      setNode(n);
      setItems(e?.catalog?.items ?? null);
    };
    void load();
    const iv = setInterval(load, 10 * 60 * 1000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const required = Object.entries(items ?? {}).filter(([, it]) => it.required);
  if (!node?.current && required.length === 0) {
    return <span className="min-w-[120px] text-xs text-muted-foreground">环境检测…</span>;
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="whitespace-nowrap">环境检测</span>
      {required.map(([id, it]) => {
        const ok = it.state === "ok" || it.state === "configured";
        return (
          <span
            key={id}
            title={it.detail || undefined}
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5",
              ok ? "text-muted-foreground/70" : "bg-warning-background font-semibold text-warning"
            )}
          >
            {!ok && <TriangleAlert className="size-3" />}
            {it.label} {it.detail || "—"}
          </span>
        );
      })}
      {/* 环境表单（内核 platform/os/environment.js 的装配面）：候选浏览器、系统默认项来源、
          图形会话与外部打开的分发依据都在这里，用户的浏览器偏好也在这里定。 */}
      <EnvironmentCard />
      {node?.ltsLine === false ? (
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-warning-background px-2 py-0.5 font-semibold text-warning" title={node.suggested || undefined}>
          <TriangleAlert className="size-3" />
          非 LTS 线（建议偶数主版本）
        </span>
      ) : node?.ltsLine === true ? (
        <span className="hidden whitespace-nowrap text-muted-foreground/70 sm:inline">LTS 线</span>
      ) : null}
    </span>
  );
}

/** 事件日志（懒加载）：先渲染 PAGE 条；滚到底部哨兵出现 -> 每次 +PAGE，直到全部渲染完。 */
function EventLogPanel({ events }: { events: SupervisorEvent[] }) {
  const PAGE = 12;
  const [visible, setVisible] = useState(PAGE);
  const total = events.length;
  useEffect(() => { setVisible(PAGE); }, [events]);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((en) => en.isIntersecting)) return;
      if (loadingRef.current) return;
      loadingRef.current = true;
      setVisible((v) => Math.min(v + PAGE, total));
      setTimeout(() => { loadingRef.current = false; }, 80);
    }, { rootMargin: "120px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [total]);
  const shown = events.slice(0, visible);
  const hasMore = visible < total;
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <CardTitle title="事件日志" subtitle="核心运行状态遥测" actions={<span className="font-mono text-xs text-muted-foreground">{total}</span>} />
      {!total ? (
        <div className="px-5 py-6 text-center text-xs text-muted-foreground">暂无核心运行状态事件</div>
      ) : (
        <div className="flex max-h-[450px] min-h-0 flex-col overflow-y-auto overscroll-contain">
          {shown.map((e, i) => <EventRow key={e.seq ?? i} e={e} />)}
          <div ref={sentinelRef} className="px-5 py-2 text-center text-[11px] text-muted-foreground">
            {hasMore ? "下滑加载更多…" : "已加载全部"}
          </div>
        </div>
      )}
    </Card>
  );
}

function EventRow({ e }: { e: SupervisorEvent }) {
  const tone = EVENT_TONE[e.type] ?? "boot";
  const label = EVENT_LABELS[e.type] ?? e.type;
  const msg = eventDetail(e);
  return (
    <div className="grid min-w-0 grid-cols-[64px_auto_minmax(0,1fr)] items-center gap-2.5 border-b border-border/60 px-5 py-2 last:border-b-0 max-[640px]:grid-cols-[56px_auto_minmax(0,1fr)] max-[640px]:gap-2">
      <span className="text-xs tabular-nums text-muted-foreground">{formatClockTime(e.ts)}</span>
      <Pill tone={tone as "ok" | "err" | "warn" | "boot" | "off"}>{label}</Pill>
      <span className="truncate text-xs text-muted-foreground">{msg}</span>
    </div>
  );
}

/** 事件 -> 人性化描述（对齐后端遥测语义；无匹配则空串——标签已表达类型） */
function eventDetail(e: SupervisorEvent): string {
  const d = e.data;
  if (!d) return "";
  const fmt = (n: unknown) => Number(n ?? 0).toLocaleString("en-US");
  // 显式 message/reason 优先
  if (typeof d.message === "string") return d.message;
  if (typeof d.reason === "string") return friendlyFailure(d.reason);
  if (typeof d.desired === "string") return "期望 " + d.desired;
  if (e.type === "router_usage") return (d.model || "") + (d.model ? " · " : "") + fmt(d.tokens) + " tokens";
  if (e.type === "router_pick") return [(d.provider || ""), (d.key || "")].filter(Boolean).join(" · ");
  if (e.type === "account_ready" || e.type === "account_frozen" || e.type === "account_banned" || e.type === "account_recovered" || e.type === "account_review" || e.type === "account_exhausted") {
    return (d.key || "") + (d.key ? " · " : "") + (d.provider || "");
  }
  if (e.type === "provider_quota_refreshed") return (d.provider || "") + " 额度已刷新";
  if (e.type === "proxy_update_available") return [(d.pkg || ""), (d.from || ""), (d.to || "")].filter(Boolean).join(" → ");
  if (e.type === "proxy_instance_started") return "port=" + (d.port ?? "") + (d.pid ? " pid=" + d.pid : "");
  // 守护/远程开关变更：写清对象（原生/实例名）+ 目标状态（远程控制三态：关闭/局域网/公网）
  if (e.type === "dsh_guardian_changed" || e.type === "inst_guardian_changed") {
    const who = d.name || (d.id === "main" ? "原生 DSH" : d.id || "实例");
    return who + " · 进程守护" + (d.enabled === true ? " → 开启" : " → 关闭");
  }
  if (e.type === "dsh_remote_changed" || e.type === "inst_remote_changed") {
    const who = d.name || (d.id === "main" ? "原生 DSH" : d.id || "实例");
    return who + " · 远程控制 → " + (d.mode === "lan" ? "局域网" : d.mode === "wan" ? "公网" : "关闭");
  }
  if (e.type === "dsh_remote_token_changed" || e.type === "inst_remote_token_changed") {
    const who = d.name || (d.id === "main" ? "原生 DSH" : d.id || "实例");
    return who + " · 访问令牌" + (d.tokenSet === true ? " → 已设置" : " → 已清除");
  }
  const parts: string[] = [];
  if (d.pid !== undefined) parts.push("pid=" + d.pid);
  if (d.port !== undefined) parts.push("port=" + String(d.port));
  if (d.version !== undefined) parts.push("v" + String(d.version));
  if (d.model && d.tokens !== undefined) parts.push(fmt(d.tokens) + " tok");
  if (d.ms !== undefined) parts.push(fmt(d.ms) + "ms");
  return parts.join(" · ");
}

/** 事件类型 -> tone */
const EVENT_TONE: Record<string, "ok" | "err" | "warn" | "boot" | "off"> = {
  running: "ok", adopted: "ok", spawned: "ok", main_instance_registered: "ok",
  upgrade_installed: "ok", upgrade_done: "ok", api_listening: "ok",
  account_ready: "ok", account_confirmed: "ok", account_recovered: "ok",
  proxy_instance_started: "ok", proxy_update_applied: "ok",
  router_provider_activated: "ok", router_provider_endpoint: "ok",
  inst_running: "ok", inst_added: "ok", inst_started: "ok", lan_instance_started: "ok",
  frpc_installed: "ok", frpc_started: "ok", plugin_install_done: "ok",
  native_installed: "ok", inst_upgraded: "ok", plugin_update_done: "ok",
  account_frozen: "err", account_banned: "err", dsh_exited: "err", unhealthy: "err",
  spawn_failed: "err", spawn_error: "err", upgrade_failed: "err", api_error: "err", api_offline: "err",
  proxy_instance_failed: "err", inst_failed: "err", inst_start_failed: "err",
  native_install_failed: "err", native_uninstall_failed: "err",
  plugin_install_job_failed: "err", plugin_update_job_failed: "err",
  plugin_uninstall_job_failed: "err", frpc_install_failed: "err", router_stream_aborted: "err",
  sigkill_sent: "err", start_timeout: "err", crash_loop_entered: "err",
  guard_exit: "warn", version_check_failed: "warn", restart_triggered: "warn",
  dsh_not_installed: "warn", sigterm_sent: "warn", account_review: "warn",
  // 配置/开关变更(黄 warn)——与运行状态绿、异常红、启动蓝区分
  dsh_guardian_changed: "warn", inst_guardian_changed: "warn",
  dsh_remote_changed: "warn", inst_remote_changed: "warn",
  dsh_remote_token_changed: "warn", inst_remote_token_changed: "warn", lan_frp_blocked: "warn",
  proxy_update_available: "warn", upgrade_started: "warn", upgrade_stopping_dsh: "warn",
  inst_restarted: "warn", native_uninstall_started: "warn",
  account_discarded: "off", router_stopped: "off", proxy_instance_stopped: "off",
  inst_stopped: "off", inst_removed: "off", lan_instance_removed: "off",
  frpc_stopped: "off", plugin_uninstall_done: "off", native_uninstalled: "off",
  upgrade_skipped: "off", router_provider_deactivated: "off", stop: "off",
};
