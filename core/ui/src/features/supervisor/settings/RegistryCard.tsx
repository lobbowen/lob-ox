import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, RadioGroup, RadioGroupItem } from "../../../framework/ui";
import { Input } from "../../../framework/ui/input";
import {
  supervisorApi, type RegistryInfo,
} from "../../../services/supervisor";
import { useSupervisorAction } from "../useSupervisorAction";
import { Card, CardTitle, Pill } from "../widgets";
import { cn } from "../../../framework/utils";

export function RegistryCard() {
  const [reg, setReg] = useState<RegistryInfo | null>(null);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [manualOrigin, setManualOrigin] = useState("");
  const [newOrigin, setNewOrigin] = useState("");
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { busy, run } = useSupervisorAction();

  useEffect(() => {
    if (!expanded || !triggerRef.current) return;
    const t = window.setTimeout(() => {
      const el = triggerRef.current;
      if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 320);
    return () => window.clearTimeout(t);
  }, [expanded]);

  const load = useCallback(async () => {
    const r = await supervisorApi.registry().catch(() => null);
    setReg(r);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!reg) return;
    setMode(reg.mode || "auto");
    setCandidates((reg.candidates ?? []).map((c) => c.origin));
    setManualOrigin(reg.manualOrigin || "");
  }, [reg]);

  const addCandidate = () => {
    const v = newOrigin.trim();
    if (!/^https?:\/\//.test(v)) { toast.error("请输入合法的镜像 URL"); return; }
    if (candidates.includes(v)) { toast.info("已在列表中"); return; }
    setCandidates((c) => [...c, v]); setNewOrigin("");
  };
  async function saveReg() {
    const body: { mode: "auto" | "manual"; origins: string[]; manualOrigin?: string } = { mode, origins: candidates };
    if (mode === "manual") {
      if (!/^https?:\/\//.test(manualOrigin.trim())) { toast.error("手动模式需提供合法镜像 URL"); return; }
      body.manualOrigin = manualOrigin.trim();
    }
    await run("reg", () => supervisorApi.registrySet(body), { success: "已保存镜像配置", refresh: false, onDone: () => void load() });
  }
  async function refreshReg() {
    await run("regr", () => supervisorApi.registryRefresh(), { success: "已探测镜像", refresh: false, onDone: () => void load() });
  }

  const latencyOf = (origin: string): number | null => {
    const p = (reg?.probes ?? []).find((x) => x.origin === origin);
    return p && p.ok ? p.latencyMs : null;
  };
  const reasonOf = (origin: string): string => {
    const r = (reg?.registries ?? []).find((x) => x.base === origin);
    if (r && !r.usable) return "形态非法：" + (r.violation || "未知");
    const p = (reg?.probes ?? []).find((x) => x.origin === origin);
    if (p && !p.ok) return "不可达：" + (p.error || "未知");
    return "未探测";
  };

  return (
    <Card>
      <CardTitle title="镜像源" subtitle="npm 拉取 / 更新检测共用此源" />
      <div className="grid gap-3 px-5 py-4">
        <RadioGroup value={mode} onValueChange={(v) => setMode(v as "auto" | "manual")} className="flex gap-3">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
            <RadioGroupItem value="auto" id="reg-auto" />
            <span>自动（按延迟选最快）</span>
          </label>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
            <RadioGroupItem value="manual" id="reg-manual" />
            <span>手动（固定指定）</span>
          </label>
        </RadioGroup>
        {mode === "manual" ? (
          <div className="grid gap-1.5">
            <div className="flex gap-2">
              <Input placeholder="https://registry.npmmirror.com" value={manualOrigin} onChange={(e) => setManualOrigin(e.target.value)} className="flex-1" />
              <Button variant="outline" onClick={() => void testLatency(manualOrigin)}>测试</Button>
            </div>
          </div>
        ) : null}
        <Collapsible open={expanded} onOpenChange={setExpanded} className="grid gap-1">
          <CollapsibleTrigger ref={triggerRef}>
            <span className="text-xs font-medium text-foreground">候选镜像列表（{candidates.length}）</span>
            {expanded ? <ChevronUp className="size-3.5 text-muted-foreground" /> : <ChevronDown className="size-3.5 text-muted-foreground" />}
          </CollapsibleTrigger>
          {!expanded ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border/70 px-3 py-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <Pill tone="ok">当前</Pill>
                <code className="truncate font-mono text-xs text-muted-foreground">{reg?.origin || "未选择"}</code>
              </div>
              {reg?.origin && latencyOf(reg.origin) != null ? (
                <span className="shrink-0 text-xs font-medium tabular-nums">{latencyOf(reg.origin)}ms</span>
              ) : null}
            </div>
          ) : null}
          <CollapsibleContent>
            <div className="rounded-md border border-border/70">
              {candidates.map((o, i) => (
                <div key={i} className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-1.5 last:border-b-0">
                  <div className="flex min-w-0 items-center gap-2">
                    {reg?.origin === o ? <Pill tone="ok">当前</Pill> : null}
                    <code className="truncate font-mono text-xs text-muted-foreground">{o}</code>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {latencyOf(o) != null ? (
                      <span className="text-xs font-medium tabular-nums" title="延迟毫秒数（自动探测）">
                        {latencyOf(o)}<span className="text-muted-foreground/60">ms</span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground/50" title={reasonOf(o)}>—</span>
                    )}
                    <Button size="chip" variant="ghost" onClick={() => setCandidates((c) => c.filter((x) => x !== o))} title="移除该候选镜像"><Trash2 className="size-3.5 text-destructive" /></Button>
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
        <div className="flex gap-2">
          <Input placeholder="https://… 添加自定义镜像" value={newOrigin} onChange={(e) => setNewOrigin(e.target.value)} className="flex-1" onKeyDown={(e) => { if (e.key === "Enter") addCandidate(); }} />
          <Button variant="outline" onClick={addCandidate}><Plus className="size-4" />添加</Button>
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" disabled={busy === "regr"} onClick={() => void refreshReg()} variant="outline"><RefreshCw className={cn("size-3.5", busy === "regr" && "animate-spin")} />重新探测</Button>
          <Button disabled={busy === "reg"} onClick={() => void saveReg()}>保存</Button>
        </div>
      </div>
    </Card>
  );
}

/** 走 POST /dist/registry/probe：本页 CSP connect-src 'self'，浏览器不可直连镜像。 */
async function testLatency(url: string) {
  if (!/^https?:\/\//.test(url)) { toast.error("请输入合法镜像 URL"); return; }
  toast.info("测试中…");
  try {
    const r = await supervisorApi.registryProbe(url.replace(/\/+$/, ""));
    if (r && r.ok === true && typeof r.latencyMs === "number") {
      toast.success("可达，延迟 " + r.latencyMs + " ms");
    } else if (r && typeof r.error === "string" && r.error) {
      toast.error("探测失败：" + r.error);
    } else {
      toast.error("不可达");
    }
  } catch (e) {
    toast.error("探测失败：" + (e instanceof Error ? e.message : String(e)));
  }
}
