/**
 * 设置 — 启动区块：自治组件，只依赖 autostart / lan-panel / access-key / close-action 四端点，
 * 与版本环境、镜像源彻底解耦——各自加载、各自失败，互不拖累。
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from "../../../framework/ui";
import { Input } from "../../../framework/ui/input";
import {
  supervisorApi, setStoredAccessKey, type AccessKeyStatus, type LanPanelStatus,
} from "../../../services/supervisor";
import { useSupervisorAction } from "../useSupervisorAction";
import { Card, CardTitle } from "../widgets";

/** 各端点独立取数与 catch：任一失败只影响本区块。 */
export function StartupCard() {
  const [autoOn, setAutoOn] = useState<boolean | null>(null);
  const [lan, setLan] = useState<LanPanelStatus | null>(null);
  const [ak, setAk] = useState<AccessKeyStatus | null>(null);
  const [akInput, setAkInput] = useState("");
  const [closeAction, setCloseAction] = useState<"hide" | "exit">("hide");
  const { busy, run } = useSupervisorAction();

  const load = useCallback(async () => {
    const [a, l, k, c] = await Promise.all([
      supervisorApi.autostart().catch(() => null),
      supervisorApi.lanPanel().catch(() => null),
      supervisorApi.accessKey().catch(() => null),
      supervisorApi.closeAction().catch(() => null),
    ]);
    if (a) setAutoOn(a.on);
    if (l) setLan(l);
    if (k) setAk(k);
    if (c) setCloseAction(c.closeAction);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggleAuto(v: boolean) {
    setAutoOn(v);
    try {
      const r = await supervisorApi.setAutostart(v);
      if (r.ok === false) { toast.error(r.error || "设置失败"); setAutoOn(!v); }
      else toast.success(v ? "已开启开机自启（整条服务链）" : "已关闭开机自启");
    } catch (e) { toast.error(String(e)); setAutoOn(!v); }
  }
  async function toggleLan(v: boolean) {
    setLan((p) => (p ? { ...p, enabled: v } : p));
    try {
      const r = await supervisorApi.setLanPanel(v);
      if (r.ok === false) { toast.error(r.error || "设置失败"); setLan((p) => (p ? { ...p, enabled: !v } : p)); return; }
      setLan(r); // 后端返回含真实 urls
      toast.success(v ? "已开启局域网访问" : "已关闭局域网访问（仅本机）");
    } catch (e) { toast.error(String(e)); setLan((p) => (p ? { ...p, enabled: !v } : p)); }
  }
  async function saveAccessKey() {
    const key = akInput.trim();
    if (key && key.length < 8) { toast.error("访问密钥至少 8 位（建议 16+ 位随机串）"); return; }
    const ok = await run("akk", () => supervisorApi.setAccessKey(key), {
      success: key ? "访问密钥已设置" : "访问密钥已清除",
      refresh: false,
      onDone: () => { setAkInput(""); void load(); },
    });
    // key 必须同步进 localStorage，否则本面板后续请求不带 Authorization，被 401 挡死；onDone 成败皆跑，故按返回值落盘。
    if (ok) setStoredAccessKey(key);
  }
  async function changeCloseAction(v: string) {
    const val = v === "exit" ? "exit" as const : "hide" as const;
    setCloseAction(val);
    await run("ca", () => supervisorApi.setCloseAction(val), {
      success: val === "exit" ? "已设为：关闭窗口时退出管家" : "已设为：关闭窗口时隐藏至托盘",
      refresh: false,
    });
  }

  return (
    <>
      <Card>
        <CardTitle title="启动" subtitle="开机行为与偏好" />
        <div className="grid gap-4 px-5 py-4">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <strong className="block text-sm font-medium text-foreground">开机自动启动管家</strong>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">开机登录后自动启动 DeepSeek Harness 管家（本程序）。不会自动启动任何单个实例——实例是否被自动拉起，由各自「进程守护」开关决定。</p>
            </div>
            {autoOn !== null ? <span title="开机自启"><Switch checked={autoOn} onCheckedChange={(v) => void toggleAuto(v)} /></span> : <span className="text-xs text-muted-foreground">…</span>}
          </div>

          <div className="flex items-start justify-between gap-6 border-t border-border/60 pt-4">
            <div className="min-w-0">
              <strong className="block text-sm font-medium text-foreground">关闭窗口时</strong>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">隐藏至托盘：管家与服务继续在后台运行；退出管家：关闭并停止全部服务。</p>
            </div>
            <Select value={closeAction} onValueChange={(v) => void changeCloseAction(v)}>
              <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="hide">隐藏至托盘</SelectItem>
                <SelectItem value="exit">退出管家</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </Card>

      <Card>
        <CardTitle title="访问" />
        <div className="grid gap-4 px-5 py-4">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <strong className="block text-sm font-medium text-foreground">管家局域网访问</strong>
              {lan ? (
                lan.enabled ? (
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    开启后，局域网内设备可通过&nbsp;
                    {(lan.urls ?? []).map((u, i) => (
                      <span key={u}>
                        {i > 0 ? "、 " : null}
                        <code className="rounded bg-muted px-1 py-px font-mono text-foreground">{u}</code>
                      </span>
                    ))}
                    &nbsp;访问本面板。
                  </p>
                ) : (
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">关闭后仅本机可访问，局域网设备不可用。</p>
                )
              ) : null}
            </div>
            {lan !== null ? <span title="局域网访问"><Switch checked={lan.enabled} onCheckedChange={(v) => void toggleLan(v)} /></span> : <span className="text-xs text-muted-foreground">…</span>}
          </div>

          <div className="flex items-start justify-between gap-6 border-t border-border/60 pt-4">
            <div className="min-w-0">
              <strong className="block text-sm font-medium text-foreground">访问密钥</strong>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                局域网或公网访问本面板需携带此密钥；本机访问不受影响。留空保存可清除。
                {ak?.configured ? <span className="mt-1 block text-status-ok">当前：已设置</span> : <span className="mt-1 block text-muted-foreground">当前：未设置</span>}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Input
              type="password" autoComplete="new-password" placeholder="输入 ≥8 位访问密钥（建议随机长串）"
              value={akInput} onChange={(e) => setAkInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void saveAccessKey(); }}
              className="flex-1"
            />
            <Button variant="outline" onClick={() => setAkInput("")} disabled={!akInput && !ak?.configured}>清除</Button>
            <Button disabled={busy === "akk"} onClick={() => void saveAccessKey()}>
              {ak?.configured ? "更新密钥" : "设置密钥"}
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}
