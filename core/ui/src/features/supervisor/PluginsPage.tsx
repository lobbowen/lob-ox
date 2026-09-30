/**
 * 插件商店（supervisor plugins）— 市场（搜索/筛选/分页）+ 已装（实例分组 + 启用/停用/更新/卸载）
 */
import { useEffect, useMemo, useState } from "react";
import { Package, Power, RefreshCw, Rocket, Search, Store, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Checkbox, RadioGroup, RadioGroupItem, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../framework/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../framework/ui/dialog";
import { useConfirm } from "../../framework/ui/confirm";
import { Input } from "../../framework/ui/input";
import { formatSize } from "../../framework/format";
import {
  pollJob,
  supervisorApi,
  type InstalledPlugin, type MarketPlugin, type MarketResponse,
} from "../../services/supervisor";
import { useSupervisorAction } from "./useSupervisorAction";
import { Card, CardTitle, Pill } from "./widgets";
import { cn } from "../../framework/utils";

type Tab = "market" | "installed";
const PAGE = 24;

/** 批量 job 轮询汇总：全部到终态后给出统一成败提示；无 jobId 时静默跳过。 */
async function pollJobsSummary(jobIds: string[], verb: string, total: number) {
  if (!jobIds.length) return;
  const t = toast.loading("正在" + verb + " " + total + " 个插件…（0/" + jobIds.length + "）");
  let done = 0, failed = 0;
  for (const id of jobIds) {
    const res = await pollJob(() => supervisorApi.pluginInstallStatus(id));
    if (res.state === "done") done++;
    else if (res.state === "failed") failed++;
    toast.loading("正在" + verb + " " + total + " 个插件…（" + (done + failed) + "/" + jobIds.length + "）", { id: t });
  }
  if (failed === 0) toast.success(verb + "完成（" + done + "/" + jobIds.length + "）", { id: t });
  else toast.warning(verb + "结束：成功 " + done + "，失败 " + failed, { id: t });
}

/**
 * 快照轮询：内核的市场重建与更新检测是「立即回快照 + 后台跑」（等同步响应只会被 15s 客户端计时误判成失败）。
 * busy 为读端点的在飞标记；超时上限须大于服务端构建预算（市场默认 4 分钟）。
 * 注意：force 只能发一次，轮询拍必须读非 force 快照——否则每拍都会再触发一轮构建，永不收敛。
 */
async function pollSnapshot<T>(read: () => Promise<T>, busy: (r: T) => boolean, timeoutMs = 300_000, intervalMs = 2_000): Promise<T> {
  let r = await read();
  const until = Date.now() + timeoutMs;
  while (busy(r) && Date.now() < until) {
    await new Promise((res) => setTimeout(res, intervalMs));
    r = await read();
  }
  return r;
}

export function PluginsPage() {
  const [tab, setTab] = useState<Tab>("market");
  const [marketNonce, setMarketNonce] = useState(0);   // 刷新收尾后让市场列表重读快照（否则要点「已安装」再回来才见新索引）
  return (
    <div className="grid content-start gap-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {(["market", "installed"] as const).map((t) => (
            <Button
              className={cn("font-medium", tab === t ? "bg-card text-foreground shadow-sm" : "bg-transparent text-muted-foreground hover:bg-card/60 hover:text-foreground")}
              key={t}
              onClick={() => setTab(t)}
              size="sm"
              variant="ghost"
            >
              {t === "market" ? <Store className="size-3.5" /> : <Package className="size-3.5" />}
              {t === "market" ? "插件商店" : "已安装"}
            </Button>
          ))}
        </div>
        {tab === "market" ? <MarketRefresh onSettled={() => setMarketNonce((n) => n + 1)} /> : null}
      </div>
      {tab === "market" ? <MarketTab nonce={marketNonce} /> : <InstalledTab />}
    </div>
  );
}

function MarketRefresh({ onSettled }: { onSettled?: () => void }) {
  const [refreshing, setRefreshing] = useState(false);
  async function go() {
    setRefreshing(true);
    try {
      const first = await supervisorApi.market(true);
      const r = first.building ? await pollSnapshot(() => supervisorApi.market(), (x) => !!x.building) : first;
      // error 非空就是构建失败，此时 plugins 是沿用下来的旧索引 —— 不能报「已刷新」
      if (r.error) toast.error("索引刷新失败：" + r.error + "（暂用旧索引的 " + r.plugins.length + " 个）");
      else if (r.plugins.length) toast.success("插件索引已刷新（" + r.plugins.length + " 个）");
      else toast.error("索引刷新失败：无结果");
      onSettled?.();
    } catch (e) { toast.error(String(e)); }
    setRefreshing(false);
  }
  return (
    <Button disabled={refreshing} onClick={() => void go()} size="chip" variant="outline">
      <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />刷新
    </Button>
  );
}

function MarketTab({ nonce = 0 }: { nonce?: number }) {
  const [index, setIndex] = useState<MarketResponse | null>(null);
  const [building, setBuilding] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [kw, setKw] = useState("");
  // Radix Select 不允许空值："all" 哨兵 = 全部
  const [cat, setCat] = useState("all");
  const [src, setSrc] = useState("all");
  const [loaded, setLoaded] = useState(0);
  const [installTarget, setInstallTarget] = useState<MarketPlugin | null>(null);
  const [targets, setTargets] = useState<Array<{ id: string; name: string }>>([]);
  const [target, setTarget] = useState("native");

  useEffect(() => {
    let alive = true;
    // 冷启动（磁盘无索引）时内核自己会起一次构建，这里只读快照轮询，不再额外 force
    void (async () => {
      try {
        let r = await supervisorApi.market();
        if (r.building) {
          if (alive) setBuilding(true);
          r = await pollSnapshot(() => supervisorApi.market(), (x) => !!x.building);
        }
        if (!alive) return;
        setBuilding(false);
        setIndex(r.plugins.length ? r : null);
        setLoadErr(r.plugins.length ? null : (r.error || "索引为空，点「刷新」重建"));
        setLoaded(PAGE);
      } catch (e) { if (alive) { setBuilding(false); setLoadErr(String(e)); } }
    })();
    return () => { alive = false; };
    // nonce：市场刷新收尾后重读快照（非 force，不会点燃第二轮构建）
  }, [nonce]);

  const filtered = useMemo(() => {
    if (!index) return [];
    const q = kw.trim().toLowerCase();
    return index.plugins.filter((p) =>
      (cat === "all" || p.category === cat) &&
      (src === "all" || p.source === src) &&
      (!q || (p.name + " " + (p.description || "")).toLowerCase().includes(q)),
    );
  }, [index, kw, cat, src]);

  const cats = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of index?.plugins ?? []) m[p.category] = (m[p.category] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [index]);

  async function openInstall(p: MarketPlugin) {
    setInstallTarget(p);
    setTarget("native");
    try {
      const r = await supervisorApi.instances();
      setTargets((r.instances ?? []).filter((i) => i.domain === "sandbox").map((i) => ({ id: i.id, name: i.name })));
    } catch { setTargets([]); }
  }
  async function confirmInstall() {
    if (!installTarget) return;
    try {
      const r = await supervisorApi.pluginInstall(installTarget.name, target);
      if (r.ok === false) { toast.error(r.error || "安装失败"); return; }
      setInstallTarget(null);
      // 安装为 job 模型：轮询到终态给出进度与成败，不停在「已提交」
      if (r.jobId) {
        const t = toast.loading("正在安装 " + installTarget.name + "…");
        const res = await pollJob(() => supervisorApi.pluginInstallStatus(r.jobId as string));
        if (res.state === "done") toast.success("已安装 " + installTarget.name, { id: t });
        else if (res.state === "failed") toast.error("安装失败：" + (res.error || "未知原因"), { id: t });
        else toast.warning("安装仍在进行（超时未完成，可稍后查看）", { id: t });
      } else {
        toast.success("安装任务已提交");
      }
    } catch (e) { toast.error(String(e)); }
  }

  return (
    <div className="grid content-start gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="搜索插件名称、描述…" value={kw} onChange={(e) => setKw(e.target.value)} />
        </div>
        <Select value={cat} onValueChange={setCat}>
          <SelectTrigger className="h-9 w-[150px] shrink-0"><SelectValue placeholder="全部分类" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部分类</SelectItem>
            {cats.map(([c, n]) => <SelectItem key={c} value={c}>{c} ({n})</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={src} onValueChange={setSrc}>
          <SelectTrigger className="h-9 w-[130px] shrink-0"><SelectValue placeholder="全部来源" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部来源</SelectItem>
            <SelectItem value="npm">npm</SelectItem>
            <SelectItem value="github">GitHub</SelectItem>
            <SelectItem value="community">社区</SelectItem>
            <SelectItem value="official">官方</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {!index ? (
        <div className="grid place-items-center py-20 text-sm text-muted-foreground">
          {building ? "正在构建插件索引（首次约需数分钟，可留在本页）…" : (loadErr || "加载插件索引…")}
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">共 {index.plugins.length} 个插件 · 更新 {index.indexedAt ? new Date(index.indexedAt).toLocaleString() : "—"} · npm {index.sources?.npm || 0} · GitHub {index.sources?.github || 0} · 社区 {index.sources?.community || 0}</p>
          {!filtered.length ? (
            <div className="grid place-items-center rounded-lg border border-dashed border-border py-16 text-sm text-muted-foreground">无匹配插件</div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2 @min-[1000px]:grid-cols-3">
                {filtered.slice(0, loaded).map((p) => (
                  <div key={p.name} className="flex min-h-[150px] flex-col rounded-lg border border-border bg-card p-4">
                    <div className="flex items-center justify-between gap-2">
                      <strong className="truncate font-mono text-sm text-foreground">{p.name}</strong>
                      <Pill tone={srcTone(p.source)}>{srcLabel(p.source)}</Pill>
                    </div>
                    <p className="mt-2 line-clamp-3 min-h-[36px] text-xs leading-relaxed text-muted-foreground">{p.description || "（无描述）"}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="rounded bg-muted px-1.5 py-0.5">{p.category}</span>
                      {p.version ? <span className="font-mono">v{p.version}</span> : null}
                      {p.stars ? <span>⭐{p.stars}</span> : null}
                    </div>
                    <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                      <span className="truncate text-xs text-muted-foreground">{p.author || ""}</span>
                      <Button onClick={() => void openInstall(p)} size="chip">安装</Button>
                    </div>
                  </div>
                ))}
              </div>
              {loaded < filtered.length ? (
                <Button className="justify-self-center" onClick={() => setLoaded((n) => n + PAGE)} variant="outline">加载更多（{loaded}/{filtered.length}）</Button>
              ) : null}
            </>
          )}
        </>
      )}

      <Dialog open={!!installTarget} onOpenChange={(o) => !o && setInstallTarget(null)}>
        <DialogContent className="max-w-[400px]">
          <DialogHeader><DialogTitle>安装插件 — {installTarget?.name}</DialogTitle></DialogHeader>
          <div className="grid gap-2">
            <RadioGroup value={target} onValueChange={setTarget} className="grid gap-2">
              {[["native", "原生实例"], ["all", "所有实例（含原生）"]].concat(targets.map((t) => ["id:" + t.id, t.name + "（" + t.id.slice(0, 8) + "…）"] as [string, string])).map(([val, label]) => (
                <label key={val} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm", target === val ? "border-primary/40 bg-primary/[0.05] text-foreground" : "border-border text-muted-foreground hover:bg-muted")}>
                  <RadioGroupItem value={val} />
                  {label}
                </label>
              ))}
            </RadioGroup>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setInstallTarget(null)} variant="outline">取消</Button>
            <Button onClick={() => void confirmInstall()}>开始安装</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const srcLabel = (s: string) => ({ npm: "npm", github: "GitHub", community: "社区", official: "官方" }[s] ?? s);
const srcTone = (s: string): "ok" | "err" | "warn" | "boot" | "off" => s === "official" ? "boot" : s === "npm" ? "ok" : s === "github" ? "warn" : "off";

/**
 * 已安装插件：表格（勾选 + 版本/大小/来源列）。
 * 批量操作在标题栏（更新/停用/启动/卸载所选）；「检查更新」后有更新的行显示「可更新」徽标。
 */
function InstalledTab() {
  const [data, setData] = useState<{ inventoryReachable?: boolean; targets?: Array<{ id: string; name: string }>; thirdParty?: InstalledPlugin[] } | null>(null);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [updatable, setUpdatable] = useState<Map<string, string>>(new Map()); // name -> 最新版
  const [checking, setChecking] = useState(false);
  const { busy, run } = useSupervisorAction();
  const askConfirm = useConfirm();

  const load = async () => {
    const r = await supervisorApi.pluginsInstalled().catch(() => null);
    setData(r);
  };
  useEffect(() => { void load(); }, []);

  const list = data?.thirdParty ?? [];
  const pluginTargets = (p: InstalledPlugin) => (p.targets && p.targets.length ? p.targets : ["native"]);
  const shown = list.filter((p) => filter === "all" || pluginTargets(p).includes(filter));

  // 勾选操作
  const toggleOne = (name: string) => setSelected((prev) => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });
  const allChecked = shown.length > 0 && shown.every((p) => selected.has(p.name));
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(shown.map((p) => p.name)));
  const selRows = shown.filter((p) => selected.has(p.name));
  const hasUpdatableSel = selRows.some((p) => updatable.has(p.name));
  const stopSel = selRows.filter((p) => p.enabled);
  const startSel = selRows.filter((p) => !p.enabled);

  async function checkUpdates() {
    setChecking(true);
    try {
      // force 只发一次，其余拍读快照；「取不到版本」与「已是最新」必须分开报（P 组口径）
      const first = await supervisorApi.pluginsCheckUpdates(true);
      const r = first.refreshing ? await pollSnapshot(() => supervisorApi.pluginsCheckUpdates(), (x) => !!x.refreshing) : first;
      const m = new Map<string, string>();
      for (const u of r.plugins ?? []) {
        if (!u.updateAvailable) continue;
        const latest = u.targets?.find((t) => t.latest)?.latest || "";
        m.set(u.name, latest);
      }
      setUpdatable(m);
      const errs = (r.plugins ?? []).filter((u) => u.error);
      const settled = m.size ? "发现 " + m.size + " 个可更新插件" : "全部插件已是最新";
      if (!r.checkedAt && r.error) toast.error("检查更新失败：" + r.error);
      else if (errs.length) toast.warning(errs.length + " 个插件取不到最新版本（" + (errs[0].error || "") + (errs.length > 1 ? " 等" : "") + "）· " + settled);
      else toast.success(settled);
      await load();
    } catch (e) { toast.error(String(e)); }
    setChecking(false);
  }
  async function updateSelected() {
    const names = selRows.filter((p) => updatable.has(p.name)).map((p) => p.name);
    if (!names.length) { toast.info("所选插件均无可用更新"); return; }
    setSelected(new Set());
    // 所选已提交更新：从 updatable 移除，按钮回归「检查更新」态
    setUpdatable((prev) => { const n = new Map(prev); for (const x of names) n.delete(x); return n; });
    await run("upd-sel", async () => {
      // 收集 jobId 统一轮询到终态再汇总反馈
      const jobIds: string[] = [];
      for (const n of names) {
        try { const r = await supervisorApi.pluginUpdate(n); if (r.jobId) jobIds.push(r.jobId); } catch { /* 单点失败跳过 */ }
      }
      await pollJobsSummary(jobIds, "更新", names.length);
    }, { success: "已提交 " + names.length + " 个插件的更新任务", refresh: false, onDone: () => void load() });
  }
  async function uninstallSelected() {
    const names = selRows.map((p) => p.name);
    if (!(await askConfirm({
      title: "卸载所选插件？",
      description: <>将卸载所选 {names.length} 个插件：<ul className="mt-2 max-h-[180px] overflow-auto rounded-md border border-border/70 bg-muted/40 px-3 py-2">{names.map((n) => <li key={n} className="truncate text-foreground">{n}</li>)}</ul></>,
      confirmText: "卸载",
      tone: "destructive",
    }))) return;
    setSelected(new Set());
    await run("uni-sel", async () => {
      const jobIds: string[] = [];
      for (const n of names) {
        try { const r = await supervisorApi.pluginUninstall(n); if (r.jobId) jobIds.push(r.jobId); } catch { /* 单点失败跳过 */ }
      }
      await pollJobsSummary(jobIds, "卸载", names.length);
    }, { success: "已提交 " + names.length + " 个插件的卸载任务", refresh: false, onDone: () => void load() });
  }
  async function stopSelected() {
    const names = stopSel.map((p) => p.name);
    setSelected(new Set());
    await run("stop-sel", async () => {
      for (const n of names) { try { await supervisorApi.pluginDisable(n); } catch { /* 单点失败跳过 */ } }
    }, { success: "已停止 " + names.length + " 个插件", refresh: false, onDone: () => void load() });
  }
  async function startSelected() {
    const names = startSel.map((p) => p.name);
    setSelected(new Set());
    await run("start-sel", async () => {
      for (const n of names) { try { await supervisorApi.pluginEnable(n); } catch { /* 单点失败跳过 */ } }
    }, { success: "已启动 " + names.length + " 个插件", refresh: false, onDone: () => void load() });
  }

  const gridCols = "grid grid-cols-[88px_minmax(0,1fr)_120px_84px_36px] items-center gap-3";

  return (
    <Card className="overflow-hidden">
      <CardTitle
        title={"已安装插件" + (data ? "（" + shown.length + "）" : "")}
        subtitle={filter === "all" ? "全部实例" : "实例：" + ((data?.targets ?? []).find((t) => t.id === filter)?.name ?? filter)}
        actions={
          <>
            {/* 常态「检查更新」，勾选可更新项后变「更新(n)」 */}
            {hasUpdatableSel ? (
              <Button disabled={busy === "upd-sel"} onClick={() => void updateSelected()} size="sm">
                <RefreshCw className="size-3.5" />更新（{selRows.filter((p) => updatable.has(p.name)).length}）
              </Button>
            ) : (
              <Button disabled={checking} onClick={() => void checkUpdates()} size="sm" variant="outline">
                <RefreshCw className={cn("size-3.5", checking && "animate-spin")} />
                {checking ? "检查中…" : "检查更新"}
              </Button>
            )}
            {selRows.length > 0 ? (
              <>
                {stopSel.length > 0 ? (
                  <Button disabled={busy === "stop-sel"} onClick={() => void stopSelected()} size="sm" variant="outline">
                    <Power className="size-3.5" />停用（{stopSel.length}）
                  </Button>
                ) : null}
                {startSel.length > 0 ? (
                  <Button disabled={busy === "start-sel"} onClick={() => void startSelected()} size="sm" variant="outline">
                    <Rocket className="size-3.5" />启动（{startSel.length}）
                  </Button>
                ) : null}
                <Button className="h-[30px]" disabled={busy === "uni-sel"} onClick={() => void uninstallSelected()} size="sm" variant="destructive">
                  <Trash2 className="size-3.5" />卸载（{selRows.length}）
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-5 py-2.5">
        <Button className={cn(filter === "all" ? "bg-primary/10 text-primary hover:bg-primary/15" : "text-muted-foreground hover:bg-muted hover:text-foreground")} onClick={() => setFilter("all")} size="sm" variant="ghost">全部实例</Button>
        {(data?.targets ?? []).map((t) => (
          <Button key={t.id} className={cn(filter === t.id ? "bg-primary/10 text-primary hover:bg-primary/15" : "text-muted-foreground hover:bg-muted hover:text-foreground")} onClick={() => setFilter(t.id)} size="sm" variant="ghost">{t.name}</Button>
        ))}
      </div>

      {!data ? <div className="py-16 text-center text-sm text-muted-foreground">加载中…</div>
        : !shown.length ? <div className="grid place-items-center rounded-lg border-0 py-16 text-center"><Package className="mx-auto mb-3 size-8 text-muted-foreground" /><p className="text-sm text-muted-foreground">当前实例均未安装第三方插件</p></div>
        : (
          <>
            <div className="overflow-x-auto">
            <div className={cn(gridCols, "min-w-[720px] border-b border-border/70 bg-muted px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground")}>
              <span>来源</span>
              <span>插件</span>
              <span>版本</span>
              <span className="text-right">大小</span>
              <span className="flex justify-end"><Checkbox aria-label="全选" checked={allChecked} onChange={toggleAll} /></span>
            </div>
            <div className="max-h-[560px] overflow-auto">
              {shown.map((p) => {
                const checked = selected.has(p.name);
                const latest = updatable.get(p.name);
                return (
                  <label
                    key={p.name}
                    className={cn(
                      gridCols,
                      "min-h-[46px] min-w-[720px] w-full cursor-pointer border-b border-border/50 px-5 py-2 text-left transition-colors last:border-b-0 hover:bg-muted/40",
                      checked && "bg-muted/70 shadow-[inset_3px_0_0_var(--primary)]",
                    )}
                  >
                    {/* 来源 badge（首列，对齐原版管理源） */}
                    <span className="inline-flex w-fit min-w-0 items-center">
                      <Pill tone={p.bundle ? "boot" : p.source?.includes("github") ? "warn" : p.source === "npm" ? "ok" : "off"}>{p.bundle ? "bundle" : p.source === "npm" ? "npm" : p.source?.includes("github") ? "GitHub" : p.source && p.source !== p.name ? "本地" : "—"}</Pill>
                    </span>
                    {/* 插件名 + 描述 + 状态 */}
                    <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                      <span className="grid min-w-0 gap-0.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <strong className="truncate font-mono text-[13px] font-semibold leading-tight text-foreground">{p.name}</strong>
                          <Pill tone={p.enabled ? "ok" : "off"}>{p.enabled ? "已启用" : "已停用"}</Pill>
                        </span>
                        {p.description ? <span className="truncate text-xs leading-tight text-muted-foreground">{p.description}</span> : null}
                      </span>
                    </span>
                    {/* 版本：有更新 -> 徽标 */}
                    <span className="min-w-0">
                      {latest ? (
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-xs text-muted-foreground">{p.version ? "v" + p.version : "—"}</span>
                          <Pill tone="warn">可更新</Pill>
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">{p.version ? "v" + p.version : "—"}</span>
                      )}
                    </span>
                    <span className="text-right font-mono text-xs tabular-nums text-foreground">{p.size ? formatSize(p.size) : "—"}</span>
                    <span className="flex justify-end"><Checkbox aria-label={"选择 " + p.name} checked={checked} onChange={() => toggleOne(p.name)} /></span>
                  </label>
                );
              })}
            </div>
            </div>
          </>
        )}
    </Card>
  );
}
