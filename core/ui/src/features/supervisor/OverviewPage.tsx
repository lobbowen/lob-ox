import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowUpRight, ExternalLink, Power, RefreshCw, Rocket,
  TerminalSquare, Trash2, TriangleAlert,
} from "lucide-react";
import type { EnvCatalogItem, NodeLtsStatus } from "../../services/supervisor";
import { toast } from "sonner";
import { Button } from "../../framework/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../../framework/ui/dialog";
import { useConfirm } from "../../framework/ui/confirm";
import { formatCount, formatClockTime } from "./format";
import { supervisorApi, supervisorStore, useSupervisorData, type SupervisorEvent } from "../../services/supervisor";
import { Card, CardTitle, Metric, Pill, ToneDot } from "./widgets";
import { cn } from "../../framework/utils";
import { PortPanel } from "./PortPanel";
import { EnvironmentCard } from "./settings/EnvironmentCard";
import { EVENT_META, SUP_PHASE_META, friendlyFailure } from "./nav";
import { useSupervisorAction } from "./useSupervisorAction";
import { runOpenExternal } from "./openExternal";

export function OverviewPage() {
  const { snap } = useSupervisorData();
  const { busy, run } = useSupervisorAction();
  const askConfirm = useConfirm();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
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

  const running = Boolean(s?.dshPid);
  const upgradeRunning = upg?.state === "running";

  // ── E2：DSH 启动按钮的可用性（product-manager 判据修正后）──
  //
  // 为什么不能只用 `!running`：`dshPid` 有两个来源（`status.js:17` 的
  // `host._mChild() ? .pid : host._mAdoptPid()`）——内核 spawn 的（受管）与
  // **认领来的外部 DSH**。它不告诉你是谁拉的 ⇒ 所以「D 态」（观测未受管）下
  // `dshPid` 也有值 ⇒ 若按钮显示「停止」而用户期望「启动」，或判成「可用」而
  // 点了内核走 `adopt()` 不起新进程 ⇒ **用户看到「点了没反应」**。
  //
  // 本轮只做前两种成因（后三种 `spawnBlockedUntil`/`portOccupied`/`observedOnly`
  // 要等 core-engineer 的第三档契约透出，Lead 已派）：
  //   ① 未装/ENOENT            ⇒ `commandMissing` ⇒ 禁用 + 「请先安装 DSH」
  //   ② 主动停（真停了）      ⇒ `desired === "stopped"` **且 `dshPid` 为空** ⇒ 可用
  //
  // ② 的关键修正（product-manager 核到）：原判据是 `desired === "stopped"`，
  // 而它覆盖两种场景——真停了（`dshPid` 空 ⇒ 点启动真起）与 D 态（`dshPid`
  // 有值 ⇒ 点启动走 `adopt()` 又回认领态）⇒ 故加 `!s?.dshPid`。
  const commandMissing = s?.commandMissing === true;
  const observedOnly = s?.observedOnly === true;
  // 「可以点启动」= 内核判定要跑 + 真停了 + 入口存在 + 不是 D 态。
  const canStartDsh = s?.desired === "stopped" && !s?.dshPid && !commandMissing && !observedOnly;
  // 启动禁用时的原因（给用户看的，不是给日志的）。
  const startBlockedReason: string | null = commandMissing
    ? "未检测到 DeepSeek Harness ⇒ 请先安装"
    : observedOnly
      ? "DSH 在运行但非本产品管理"
      : null;

  // ── ④ C 态引导：认领来的 DSH 不受本产品退出管理 ⇒ 引导用户停掉它、交由本产品启动 ──
  //
  // C 态的判据：`adopted`（内核认领了它）+ `observedOnly`（观测未受管）⇒
  // 而壳退时杀不掉它（那正是 S-7b：`assign_to_job` 被 OS 拒，因为它的父是
  // 用户桌面快捷方式、不在壳进程树内）。
  //
  // 载体 `sessionStorage` + key 带 pid（`lobox.c-adopt-guide.<pid>`）：
  //   ⇒ 停掉一个、起来另一个（新 pid）会**再引导**；
  //   ⇒ 而**可关闭但不永久消失**（重开面板会再显示）⇒ 用户第二次遇到时仍有引导。
  //   ⚠️ 不用 localStorage：那会让「本次会话关掉」变成「永远不再出现」。
  //
  // 10 秒等待态（product-manager 核出）：用户点「停掉 DSH，交由本产品启动」后
  // ⇒ 内核 `portReleaseWaitMs: 10000`（`config.js:39`）⇒ 约 10 秒空窗
  // ⇒ 若按钮不禁用，用户会重复点 ⇒ 而 `spawnBlockedUntil` 只挡 spawn 不挡重复 stop
  // ⇒ 故点后禁用 + 「正在重新启动…」直到 `dshPid` 重新出现。
  const cAdoptPid = s?.dshPid != null ? String(s.dshPid) : null;
  const cGuideKey = cAdoptPid ? `lobox.c-adopt-guide.${cAdoptPid}` : null;
  const [cGuideDismissed, setCGuideDismissed] = useState<string[]>(() => {
    try {
      const raw = globalThis.sessionStorage?.getItem("lobox.c-adopt-guide.dismissed") || "[]";
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  const [cStopping, setCStopping] = useState(false);
  const cGuideVisible = Boolean(
    s?.adopted && observedOnly && cGuideKey && !cGuideDismissed.includes(cGuideKey),
  );

  // 10 秒等待态的收敛：点停后轮询 `dshPid` 是否重新出现（内核停掉旧的、再起一个受管的）。
  useEffect(() => {
    if (!cStopping) return;
    let alive = true;
    const started = Date.now();
    const tick = () => {
      if (!alive) return;
      const cur = supervisorStore.snapshot?.status;
      if (cur?.dshPid && !cur.observedOnly) {
        setCStopping(false);
        return;
      }
      if (Date.now() - started > 30000) {
        // 30 秒仍没起来 ⇒ 停手并恢复按钮（不无限禁用）。
        setCStopping(false);
        return;
      }
      globalThis.setTimeout(tick, 500);
    };
    globalThis.setTimeout(tick, 500);
    return () => {
      alive = false;
    };
  }, [cStopping]);

  function dismissCGuide() {
    if (!cGuideKey) return;
    setCGuideDismissed((prev) => {
      const next = prev.includes(cGuideKey) ? prev : [...prev, cGuideKey];
      try {
        globalThis.sessionStorage?.setItem("lobox.c-adopt-guide.dismissed", JSON.stringify(next));
      } catch {
        /* 隐私模式下 sessionStorage 可能抛 ⇒ 不影响本次会话的隐藏 */
      }
      return next;
    });
  }

  async function stopAndTakeOver() {
    if (!(await askConfirm({
      title: "停掉 DSH，交由本产品启动？",
      description:
        "当前这个 DSH 是在本产品之前启动的，系统的权限设置使本产品无法在退出时停止它。"
        + "停掉它之后，本产品会自动启动一个由自己管理的 DSH。",
      confirmText: "停掉并交由本产品启动",
    }))) return;
    setCStopping(true);
    await run("dsh", () => supervisorApi.lifecycleStop("dsh"), { success: "正在停止 DSH…" });
    // 停之后不立刻清 cStopping：等上面的轮询看到新 dshPid（受管）再清。
  }

  const events = useMemo(() => snap.events.filter((e) => !EVENT_META[e.type]?.noise), [snap.events]);

  async function toggleDsh() {
    await run("dsh", () => (running ? supervisorApi.lifecycleStop("dsh") : supervisorApi.lifecycleStart("dsh")), { success: running ? "正在停止 DSH…" : "正在启动 DSH…" });
  }
  async function stopDsh() {
    if (!(await askConfirm({
      title: "停止 DSH？",
      description: "主干 DeepSeek Harness 正在运行；停止会中断进行中的请求，远程访问同时不可用。",
      confirmText: "停止 DSH",
    }))) return;
    await toggleDsh();
  }
  async function openWeb() {
    // 三档结果与地址由 notifyOpen 呈现：run 的通用判据会把「只是交出去了」也报成丢地址错误
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
  }
  async function upgradeDsh() {
    setUpgradeOpen(false);
    await run("upg", () => supervisorApi.nativeUpgrade(), { success: "升级已开始，请耐心等待…" });
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



  const installedVer = installed ? (native?.version || v?.installed || "—") : "—";

  return (
    <div className="grid content-start gap-4">
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
          <div className="hidden lg:block">
            <EnvDetect />
          </div>
          {/* ④ C 态引导：DSH 在跑但非本产品管理 ⇒ 壳退时停不掉它。 */}
          {cGuideVisible ? (
            <div className="w-full rounded-md border border-status-warn/40 bg-status-warn/5 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 text-xs leading-relaxed">
                  <div className="font-medium text-status-warn">这个 DSH 不是由本产品启动的</div>
                  <div className="mt-0.5 text-muted-foreground">
                    它在本产品之前启动，系统的权限设置使本产品无法在退出时停止它。
                    若要改由本产品启动，停掉 DSH 后本产品会自动启动。
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={cStopping || busy === "dsh"}
                    onClick={() => void stopAndTakeOver()}
                  >
                    {cStopping ? "正在重新启动…" : "停掉 DSH，交由本产品启动"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={dismissCGuide}>
                    本次会话不再提示
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
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
                <Button
                  disabled={busy === "dsh" || (!running && !canStartDsh)}
                  onClick={() => void (running ? stopDsh() : toggleDsh())}
                  size="sm"
                  variant="outline"
                  title={!running && startBlockedReason ? startBlockedReason : undefined}
                >
                  {running ? <><Power className="size-4 text-status-error" />停止 DSH</> : <><Rocket className="size-4 text-primary" />启动 DSH</>}
                </Button>
                {!running && startBlockedReason ? (
                  <span className="text-xs text-muted-foreground">{startBlockedReason}</span>
                ) : null}
                <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
              </>
            ) : null}
            {installed && !nBusy ? (
              <>
                <Button className="hidden h-[30px] md:inline-flex" disabled={busy === "uni"} onClick={() => void uninstallDsh()} size="sm" variant="destructive">
                  <Trash2 className="size-4" />卸载 DSH
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </Card>

      <div className="grid items-start gap-4 @min-[860px]:grid-cols-[minmax(0,1fr)_420px]">
        <EventLogPanel events={events} />
        <PortPanel providers={snap.providers?.providers ?? []} />
      </div>

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

/** 必填项取 /env/status 的 catalog（Node 与 npm 一律同现）；LTS 提示取 /env/node-lts（LTS 建议，非工具链清单）。 */
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
      {/* 环境表单：装配面在内核 platform/os/environment.js */}
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

function EventLogPanel({ events }: { events: SupervisorEvent[] }) {
  const PAGE = 12;
  const [visible, setVisible] = useState(PAGE);
  const total = events.length;
  // 依赖改为**稳定量**（首条事件 seq + 总数）：心跳每 2s 产生新数组引用，
  // 若依赖 events 本身 ⇒ 每次心跳都重置分页，用户下滑加载的进度被强制复位（S7 修的 P0）。
  const firstSeq = events.length ? events[0]?.seq : undefined;
  useEffect(() => { setVisible(PAGE); }, [firstSeq, total]);
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
  const meta = EVENT_META[e.type];
  const tone = meta?.tone ?? "boot";
  const label = meta?.label ?? e.type;
  const msg = eventDetail(e);
  return (
    <div className="grid min-w-0 grid-cols-[64px_auto_minmax(0,1fr)] items-center gap-2.5 border-b border-border/60 px-5 py-2 last:border-b-0 max-[640px]:grid-cols-[56px_auto_minmax(0,1fr)] max-[640px]:gap-2">
      <span className="text-xs tabular-nums text-muted-foreground">{formatClockTime(e.ts)}</span>
      <Pill tone={tone as "ok" | "err" | "warn" | "boot" | "off"}>{label}</Pill>
      <span className="truncate text-xs text-muted-foreground">{msg}</span>
    </div>
  );
}

function eventDetail(e: SupervisorEvent): string {
  const d = e.data;
  if (!d) return "";
  // 数字千分位统一用 format.ts 的 formatCount（此前这里内联了一份逐字相同的实现）。
  const fmt = (n: unknown) => formatCount(typeof n === "number" ? n : null);
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
  if (e.type === "harness_remote_changed" || e.type === "inst_remote_changed") {
    const who = d.name || (d.id === "main" ? "原生 DSH" : d.id || "实例");
    return who + " · 远程控制 → " + (d.mode === "lan" ? "局域网" : d.mode === "wan" ? "公网" : "关闭");
  }
  if (e.type === "harness_remote_token_changed" || e.type === "inst_remote_token_changed") {
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
