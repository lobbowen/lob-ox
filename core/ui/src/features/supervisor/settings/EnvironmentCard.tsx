/**
 * 环境检测 — 本机环境表单：所有「把地址交给浏览器」动作的分发依据都在这里。
 *
 * 为什么做成表单而不是各处自己探一次：一台机器上装了哪些浏览器、系统说不说得清默认项、
 * 有没有图形会话，每项都可能与另一台机器不同；此前每个动作各摸各的、各解释各的结果，
 * 于是「点了没弹出来」在界面上一句都说不清。表单把事实收在一处并写明每一层判定，
 * 用户能在这里定一次偏好，支持排障能直接读快照路径。
 *
 * 数据只走 supervisorApi（fetch 唯一处）；本组件自加载自失败，不拖累概览其余部分。
 */
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { Button, RadioGroup, RadioGroupItem } from "../../../framework/ui";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../../framework/ui/dialog";
import { supervisorApi, type EnvironmentForm, type EnvironmentSection, type EnvironmentSnapshotRead, type EgressSectionData } from "../../../services/supervisor";
import { cn } from "../../../framework/utils";

/** 运行时条目的显示字（内核 EnvCatalog 条目视图）：state 已含版本门槛判定，这里只如实摊开。 */
function entryText(e?: Record<string, unknown> | null): string {
  if (!e) return "未读出";
  const st = String(e.state || "?");
  const detail = e.detail ? "（" + String(e.detail) + "）" : "";
  return (String(e.label || "") || "条目") + " " + st + detail;
}

/** 维度读数状态字：pending / empty / error 三态各说一句 —— 把「这一拍还没探」显示成「本机没有」
 *  正是此前多个就绪口径互相顶替的根病，未探必须带上「怎么补」的出路。 */
function sectionState(sec?: EnvironmentSection): string {
  if (!sec || sec.state === "pending") return "未探测（点「重新探测」补齐）";
  if (sec.state === "error") return "探测失败：" + (sec.error || "未给出原因");
  if (sec.state === "empty") return "已探测，无内容";
  return "已探测" + (sec.at ? " " + new Date(sec.at).toLocaleTimeString() : "");
}

/** 代理读数的人话版：unknown 必须说成「取不到」而不是「没有」—— 内核正是按这个差别决定
 *  隔离窗口保不保留的，界面把它显示成「未启用」就会诱导用户去动一个并不需要动的设置。 */
function proxyText(proxy?: NonNullable<EgressSectionData["proxy"]> | null): string {
  const p: NonNullable<EgressSectionData["proxy"]> = proxy || {};
  if (p.state === "on") return "在用（" + (p.server || p.pac || "地址未读出") + "）";
  if (p.state === "off") return "系统里明确未启用";
  if (p.state === "unknown") return "取不到" + (p.source ? "（" + p.source + "）" : "") + "，按判不出处理";
  return "未探测";
}

/** 通路三态的显示字：null = 判不出，绝不能显示成「不通」。 */
function reachText(ok?: boolean | null): string {
  return ok === true ? "可达" : ok === false ? "不通" : "判不出";
}

/** 探测留痕行的显示字（与内核 form().probed 同源）：egress 行的行名已带 reach: 前缀，其余带维度名。 */
function probeText(p: { section?: string; source: string; detail?: string | number | null }): string {
  return (p.section ? p.section + "：" : "") + p.source + "：" + String(p.detail ?? "");
}

/** 距今多久的人话版（只用于「这条留痕有多旧」，不参与任何可用性判定；读不出就说读不出）。 */
function agoText(ms?: number | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "时间未读出";
  if (ms < 60000) return "刚刚";
  if (ms < 3600000) return Math.floor(ms / 60000) + " 分钟前";
  if (ms < 86400000) return Math.floor(ms / 3600000) + " 小时前";
  return Math.floor(ms / 86400000) + " 天前";
}

/** 三态布尔的显示字：「否」与「没读到」是两件事 —— 启动段只记真走过的步，格子空着就是没走到。 */
function triText(v?: boolean | null): string {
  return v === true ? "是" : v === false ? "否" : "未读出";
}

/** 同一事实的两个采集者并排写：内核探针（本进程现在解析到的）与桌面壳上报（装内核时真正用的那一套）。
 *  缺哪一侧就说哪一侧缺，绝不拿另一侧顶上 —— 用壳的数替内核填坑，正是「覆盖」那套做法会犯的错；
 *  两侧都有且读数不同则要明说，因为「探针的 npm 与装内核的 npm 不是同一个」这类缺陷只有并排才看得见。 */
function compareRow(label: string, kernel?: string | null, shell?: string | null): string {
  const k = kernel || "";
  const s = shell || "";
  const clash = k && s && k !== s ? "（两份不一致：装内核用的是壳那套，本进程解析到的是内核这套）" : "";
  return label + " 内核 " + (k || "未读出") + " ／ 壳 " + (s || "未报") + clash;
}

/** 壳的一条探测明细：三态 ok 各说一句，判不出不许显示成不通（与内核 reachText 同一纪律）。 */
function shellRecordText(r: { probe?: string | null; source?: string | null; target?: string | null; ms?: number | null; ok?: boolean | null; note?: string | null }): string {
  const ok = r.ok === true ? "通" : r.ok === false ? "不通" : "判不出";
  return (r.probe || "明细") + " " + ok + (r.target ? "（" + r.target + "）" : "") + (typeof r.ms === "number" ? " " + r.ms + " 毫秒" : "");
}

/** 本拍落盘读数：读缓存那一拍压根不写盘，要先按这条分清，否则会把上次装配的 written 冒成本拍成果。 */
function writeText(snap?: EnvironmentForm["snapshot"], cached?: boolean): string {
  if (!snap) return "未给出（这一拍没装配）";
  if (cached) return "没落盘（这一拍读的是内核缓存拍）";
  if (snap.written === true) return "已写入";
  if (snap.error) return "失败：" + snap.error;
  return "没落盘（也没报错误）";
}

/** 上一拍留痕的一句话（只读回看，与当拍字段分开渲染）：available 为假要分得清没落过盘与读不出，
 *  后者是要人去查文件的故障，说成「还没写过」会引着人去点刷新；连读回口本身都失败时更不许显示成「没有」。 */
function lastSnapshotText(last?: EnvironmentSnapshotRead | null, err?: string | null): string {
  if (err) return "读不回：" + err;
  if (!last) return "未读";
  if (last.available === true) {
    const at = typeof last.at === "number" ? new Date(last.at).toLocaleString() : "时间未读出";
    const n = last.data && last.data.browsers ? last.data.browsers.length : null;
    return at + "（" + agoText(last.ageMs) + "）" + (n === null ? "" : "，候选 " + n + " 个");
  }
  if (last.reason === "never-written") return "这台机器还没落过盘";
  return "快照文件读不出或版本不符（不是没写过，得查文件）";
}

/** 上一拍刷新里没补齐的维度：state 非 ok 全列出 —— 「这一行为什么没数据」的答案就在这串名字里。 */
function pendingDims(dims?: Record<string, string> | null): string {
  const d = dims || {};
  const miss = Object.keys(d).filter((k) => d[k] !== "ok");
  return miss.length ? "未补齐：" + miss.join("、") : "全部维度补齐";
}

/** 分发依据的人话版：内核给的是层名，用户要看到的是「这次用谁、是不是我选的」。 */
function pickText(pick?: EnvironmentForm["pick"]): string {
  const name = pick && pick.name ? pick.name : "未定出";
  if (!pick || !pick.how) return "现在会用：" + name;
  if (pick.how === "user-preference") return "现在会用：" + name + "（你选的）";
  if (pick.how === "candidate-rank") return "现在会用：" + name + "（系统未报默认项，按候选次序取首个，可在此改）";
  if (pick.how === "only-installed") return "现在会用：" + name + "（本机唯一候选）";
  if (pick.how === "none-found") return "本机未探到可用浏览器，请安装或启用一个后重新探测";
  return "现在会用：" + name + "（系统默认项）";
}

/** 「跟随系统」在 RadioGroup 里的取值：Radix 的 item 不许空串 value，故用哨兵映射到内核的空偏好。 */
const FOLLOW_SYSTEM = "__system__";

export function EnvironmentCard() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<EnvironmentForm | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 未保存的选择：null = 未改动（跟随表单里的当前偏好）。保存成功即清空，重探同样清空。
  const [draft, setDraft] = useState<string | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  // 上一拍快照的读回：与当拍表单分开加载、分开失败。它只是留痕，读不回不该把刚探出来的实况一起判死。
  const [last, setLast] = useState<EnvironmentSnapshotRead | null>(null);
  const [lastErr, setLastErr] = useState<string | null>(null);

  const load = useCallback(async (force: boolean) => {
    if (force) setProbeBusy(true);
    try {
      const r = await supervisorApi.environment(force);
      setForm(r);
      setDraft(null);
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message || e));
    }
    setProbeBusy(false);
    // 不 await：这条读回既零摸网也零写盘，但要它失败时只影响自己那一行。
    void supervisorApi.environmentLast()
      .then((r) => { setLast(r); setLastErr(null); })
      .catch((e) => { setLast(null); setLastErr(String((e as Error).message || e)); });
  }, []);

  useEffect(() => {
    // 打开时才装配：概览页轮询不得反复触发内核的注册表/目录扫描。
    if (!open) return;
    void load(false);
  }, [open, load]);

  const save = async (id: string) => {
    setSaveBusy(true);
    let r: { ok?: boolean; error?: string | null } = { ok: false, error: "偏好写入未返回结果" };
    try { r = await supervisorApi.setExternalBrowser(id); } catch (e) { r = { ok: false, error: String((e as Error).message || e) }; }
    setSaveBusy(false);
    if (!r || r.ok !== true) { setErr((r && r.error) || "偏好写入失败"); return; }
    setErr(null);
    await load(true);
  };

  const browsers = form?.browsers ?? [];
  // 维度台账：异步维度（出网条件/运行时/DSH）由内核按拍补齐，本卡片只渲染读数、不自判。
  const sections = form?.sections;
  const stale = form?.pick?.stale === true;
  const current = form?.preference?.id || FOLLOW_SYSTEM;
  const chosen = draft !== null ? draft : current;
  // 启动段逐字摊开内核记录：格子空着就显示「未读出」，界面一栏推断都不补 —— 补出来的因果链正是排障的噪声。
  const startup = sections?.startup?.data;
  // 壳上报维与 runtime 维并排渲染：同一批事实的两个采集者，隔开就等于把矛盾拆成两处。
  const shell = sections?.shell?.data;
  const shellRegistry = shell?.registry;
  const shellProbes = shellRegistry?.probes || [];
  const shellRecords = shell?.records || [];
  const shellLatency = shellRegistry?.latencyMs;
  const shellProbesTotal = shellRegistry?.probesTotal ?? 0;
  // 内核侧版本取自 EnvCatalog 条目视图（node 另有 version 字段，npm 的版本就在 detail 里）。
  const kernelNodeVersion = (sections?.runtime?.data?.node?.version as string | undefined) || null;
  const kernelNpmVersion = (sections?.runtime?.data?.npm?.detail as string | undefined) || null;

  return (
    <>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-xs text-muted-foreground" onClick={() => setOpen(true)}>
          <ExternalLink className="size-3" />环境表单
        </Button>
        {form?.pick?.name ? (
          <span className="text-xs text-muted-foreground/70">{form.pick.name}</span>
        ) : null}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader><DialogTitle>本机环境表单</DialogTitle></DialogHeader>
          <div className="grid max-h-[60vh] gap-3 overflow-y-auto text-sm">
            <p className={cn("text-xs", stale || !browsers.length ? "font-semibold text-warning" : "text-muted-foreground")}>
              {pickText(form?.pick)}
            </p>
            {stale ? (
              <p className="inline-flex items-start gap-1.5 rounded-md bg-warning-background px-2 py-1.5 text-xs font-semibold text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                你先前选的浏览器已不在本机候选清单（可能已卸载或路径变更），下方选择已回落到系统判定，请重选或清除。
              </p>
            ) : null}
            {err ? <p className="text-xs text-status-error">{err}</p> : null}

            <div className="grid gap-2 rounded-md border border-border/60 px-3 py-2.5">
              <span className="text-xs font-medium">打开地址用哪个浏览器</span>
              <RadioGroup value={chosen} onValueChange={setDraft} className="grid gap-1.5">
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
                  <RadioGroupItem value={FOLLOW_SYSTEM} id="env-pref-system" />
                  <span>跟随系统默认（本机探不到默认项时按候选次序）</span>
                </label>
                {browsers.map((b) => (
                  <label key={b.id} className="inline-flex cursor-pointer items-center gap-2 text-xs">
                    <RadioGroupItem value={b.id} id={"env-pref-" + b.id} />
                    <span>{b.name || b.bin}</span>
                    <span className="text-muted-foreground/70">{b.engine}</span>
                    {b.isDefault ? <span className="text-muted-foreground/70">系统默认</span> : null}
                  </label>
                ))}
              </RadioGroup>
              {browsers.length ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={saveBusy || chosen === current}
                          onClick={() => void save(chosen === FOLLOW_SYSTEM ? "" : chosen)}>保存偏好</Button>
                  <Button size="sm" variant="ghost" disabled={saveBusy || current === FOLLOW_SYSTEM} onClick={() => void save("")}>清除</Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">候选为空：重新探测后仍为空时，请先在系统里安装或启用一个浏览器。</p>
              )}
            </div>

            <div className="grid gap-1.5 rounded-md border border-border/60 px-3 py-2.5">
              <span className="text-xs font-medium">出网条件（隔离登录窗口的分发依据）</span>
              <span className="text-xs text-muted-foreground">{sectionState(sections?.egress)}</span>
              {sections?.egress?.data ? (
                <div className="grid gap-0.5 text-xs">
                  <span className="text-muted-foreground">
                    系统代理：{proxyText(sections?.egress?.data?.proxy)}
                  </span>
                  {Object.entries(sections?.egress?.data?.targets || {}).map(([host, t]) => (
                    <span key={host} className="text-muted-foreground">
                      {host}：{reachText(t?.ok)}{t?.stage ? "（停在 " + t.stage + (t.detail ? " " + t.detail : "") + "）" : ""}
                    </span>
                  ))}
                  {!Object.keys(sections?.egress?.data?.targets || {}).length ? (
                    <span className="text-muted-foreground">还没有目标域被问过：一键登录时会当场判定并记在这里。</span>
                  ) : null}
                </div>
              ) : null}
              {sections?.egress?.data?.proxy?.state === "off" ? (
                <p className="text-xs text-muted-foreground">
                  没有在用系统代理时，直连不通的授权域只能靠现有浏览器窗口的既有出网路径打开（隔离冷档案会是空白页）。
                </p>
              ) : null}
            </div>

            <div className="grid gap-1.5 rounded-md border border-border/60 px-3 py-2.5">
              <span className="text-xs font-medium">运行时与 DSH（安装/升级动作的分发依据）</span>
              <span className="text-xs text-muted-foreground">{sectionState(sections?.runtime)}</span>
              {sections?.runtime?.data ? (
                <div className="grid gap-0.5 text-xs text-muted-foreground">
                  <span>{entryText(sections?.runtime?.data?.node)} · {entryText(sections?.runtime?.data?.npm)} · {entryText(sections?.runtime?.data?.git)}</span>
                  <span>
                    镜像源：{sections?.runtime?.data?.registry?.origin || "未读出"}
                    {sections?.runtime?.data?.registry?.mode ? "（" + sections.runtime.data.registry.mode + "）" : ""}
                    {" · 候选 " + (sections?.runtime?.data?.registry?.candidates || []).length + " 个"}
                  </span>
                  <span className="break-all">全局前缀：{sections?.runtime?.data?.prefix || "未实测（npm root -g 未返回）"}</span>
                </div>
              ) : null}
              <span className="text-xs font-medium">桌面壳所见（装内核时真正用的那一套，与上面的内核读数并排对照）</span>
              <span className="text-xs text-muted-foreground">{sectionState(sections?.shell)}</span>
              {shell ? (
                <div className="grid gap-0.5 text-xs text-muted-foreground">
                  <span>
                    {shell.available === true
                      ? "壳上报于 " + agoText(shell.ageMs) + "，写入者 " + (shell.writtenBy || "未署名") + "（报告版本 " + (shell.schema ?? "未读出") + "）"
                      : shell.reason === "never-written"
                        ? "这台机器的壳还没报过：内核由命令行或别的进程拉起时这是常态，不是故障"
                        : "壳报的文件读不出或版本不符（不是没写过，得查那个文件）"}
                  </span>
                  {shell.available === true ? (
                    <div className="grid gap-0.5">
                      <span className="break-all">{compareRow("Node：", kernelNodeVersion, shell.node?.version)}</span>
                      <span className="break-all">{compareRow("npm：", kernelNpmVersion, shell.npm?.version)}</span>
                      <span className="break-all">{compareRow("镜像源：", sections?.runtime?.data?.registry?.origin, shell.registry?.best)}</span>
                      <span className="break-all">{compareRow("全局前缀：", sections?.runtime?.data?.prefix, shell.prefix?.dir)}</span>
                      {shell.node && shell.node.ok !== true ? (
                        <span>壳判 Node 达标：{triText(shell.node.ok)}（{shell.node.version || "版本未报"}，门槛 {shell.node.min || "未报"}）</span>
                      ) : null}
                      {shell.prefix && shell.prefix.writable !== true ? (
                        <span className="break-all">壳判前缀可写：{triText(shell.prefix.writable)}{shell.prefix.why ? "（" + shell.prefix.why + "）" : ""}</span>
                      ) : null}
                      {(shellProbes.length || shellRegistry?.best) ? (
                        <span className="break-all">
                          壳的镜像源候选：{shellProbes.map((p) => (p.url || "?") + " " + reachText(p.ok)).join("、")}
                          {typeof shellLatency === "number" ? "（择优选中用时 " + shellLatency + " 毫秒）" : ""}
                          {shellProbesTotal > shellProbes.length
                            ? "（报告里共 " + shellProbesTotal + " 个候选，此处只列前 " + shellProbes.length + " 个）" : ""}
                        </span>
                      ) : null}
                      {shellRecords.length ? (
                        <span>
                          壳的探测明细 {shellRecords.length} 条：{shellRecords.slice(0, 8).map(shellRecordText).join("；")}
                          {shellRecords.length > 8 ? "…其余见内核快照文件" : ""}
                          {shell.droppedRecords ? "（报告送达时被截断 " + shell.droppedRecords + " 条）" : ""}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <span className="text-xs text-muted-foreground">{sectionState(sections?.dsh)}</span>
              {sections?.dsh?.data ? (
                <div className="grid gap-0.5 text-xs text-muted-foreground">
                  <span>{entryText(sections?.dsh?.data?.dsh)} · {entryText(sections?.dsh?.data?.selfUpdate)}</span>
                  <span>看护：{sections?.dsh?.data?.managed ? "守卫托管" : "未托管"}{sections?.dsh?.data?.phase ? " · " + sections.dsh.data.phase : ""}</span>
                </div>
              ) : null}
            </div>

            <div className="grid gap-1.5 rounded-md border border-border/60 px-3 py-2.5">
              <span className="text-xs font-medium">启动既成事实（守卫这一拍真的跑过什么）</span>
              <span className="text-xs text-muted-foreground">{sectionState(sections?.startup)}</span>
              {startup ? (
                <div className="grid gap-0.5 text-xs text-muted-foreground">
                  <span>
                    守卫启动于 {typeof startup.bootAt === "number" ? new Date(startup.bootAt).toLocaleTimeString() : "未读出"}
                    ，环境表单首拍排在启动后 {startup.envDelayMs ?? "未读出"} 毫秒
                  </span>
                  <span>
                    选路：自动启动 {triText(startup.routerAutostart)}，模式 {startup.routerMode || "未读出（这一拍没走到那步）"}
                  </span>
                  <span>
                    更新检查：{!startup.updateCheck ? "未记录" : startup.updateCheck.enabled
                      ? "开（首查排在启动后 " + (startup.updateCheck.initialDelayMs ?? "未读出") + " 毫秒，之后每 " + (startup.updateCheck.intervalMs ?? "未读出") + " 毫秒）"
                      : "关（配置里就禁掉了，这同样是一条既成事实）"}
                  </span>
                  <span>壳看护：{triText(startup.shellWatchdog)}</span>
                  <span>
                    {startup.lastRefresh
                      ? "最近一次表单刷新于 " + (typeof startup.lastRefresh.at === "number" ? new Date(startup.lastRefresh.at).toLocaleTimeString() : "未读出")
                        + "，耗时 " + (startup.lastRefresh.tookMs ?? "未读出") + " 毫秒"
                        + "，浏览器 " + (startup.lastRefresh.browsers ?? "未读出") + " 个"
                        + "，分发依据 " + (startup.lastRefresh.pick || "未定出")
                        + "，落盘 " + triText(startup.lastRefresh.snapshotWritten)
                        + "；" + pendingDims(startup.lastRefresh.dims)
                      : "这一拍还没跑过表单刷新（首拍排在上面那个延迟之后）"}
                  </span>
                </div>
              ) : null}
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">平台</dt>
              <dd className="font-mono">{[form?.identity?.platform, form?.identity?.arch].filter(Boolean).join(" / ") || "—"}</dd>
              <dt className="text-muted-foreground">图形会话</dt>
              <dd>{form?.session?.available ? "可用（" + (form?.session?.reason || "—") + "）" : "不可用（" + (form?.session?.reason || "—") + "）"}</dd>
              <dt className="text-muted-foreground">系统默认项</dt>
              <dd>{form?.default ? form.default.id + "（来源 " + (form.default.source || "未读出") + "）" : "未读出"}</dd>
              <dt className="text-muted-foreground">候选</dt>
              <dd>{browsers.length ? browsers.map((b) => (b.name || b.bin) + "[" + (b.sources || []).join("+") + "]").join("、") : "无"}</dd>
              <dt className="text-muted-foreground">探测留痕</dt>
              <dd className="grid gap-0.5">
                {(form?.probed ?? []).map((p, i) => (
                  <span key={i} className="text-muted-foreground/80">{probeText(p)}</span>
                ))}
              </dd>
              <dt className="text-muted-foreground">快照落盘</dt>
              <dd className="break-all font-mono text-muted-foreground/80">
                {writeText(form?.snapshot, form?.cached === true)}
                <span className="text-muted-foreground/60"> {form?.snapshot?.path || "未给出路径"}</span>
              </dd>
              <dt className="text-muted-foreground">上一拍留痕</dt>
              <dd className="text-muted-foreground">{lastSnapshotText(last, lastErr)}</dd>
            </dl>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={probeBusy} onClick={() => void load(true)}>
              <RefreshCw className="size-4" />{probeBusy ? "探测中…" : "重新探测"}
            </Button>
            <Button onClick={() => setOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
