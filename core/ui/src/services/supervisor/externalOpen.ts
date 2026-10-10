import { supervisorApi } from "./client";
import type { OpenExternalResult, ProxyLoginStart } from "./types";

export function servedByKernelHost(): boolean {
  const h = String(window.location.hostname || "").toLowerCase();
  return h === "localhost" || h === "[::1]" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export function openViaWindow(url: string): OpenExternalResult {
  try {
    const w = window.open(url, "_blank", "noopener,noreferrer");
    return w
      ? { ok: true, confirmed: true, handedOff: false, url, message: "已在新标签打开", evidence: { via: "window" } }
      : { ok: false, url, error: "浏览器拦截了新窗口，请允许弹窗或复制下方地址打开" };
  } catch (e) {
    return { ok: false, url, error: String(e) };
  }
}

export async function handOffFromPanel(url: string): Promise<OpenExternalResult> {
  if (!url) return { ok: false, error: "没有可打开的地址" };
  if (servedByKernelHost()) return supervisorApi.envOpenUrl(url);
  return openViaWindow(url);
}

export type OpenTier = "confirmed" | "handed-off" | "failed";

export function evidenceDetail(ev?: OpenExternalResult["evidence"]): string | null {
  if (!ev || typeof ev !== "object") return null;
  const exe = typeof ev.bin === "string" ? ev.bin.split(/[\\/]/).pop() : null;
  const bits: string[] = [];
  if (exe) bits.push(exe);
  else if (ev.via === "none") bits.push("未定出启动对象");
  if (ev.via) bits.push(ev.via);
  if (ev.engine) bits.push("引擎 " + ev.engine);
  if (ev.ownsWindow === false) bits.push("退出码不作证据");
  if (ev.watch === true) bits.push("关掉该窗口即取消本次登录");
  if (ev.exitCode !== undefined && ev.exitCode !== null) bits.push("exit " + String(ev.exitCode));
  else if (ev.exitSignal) bits.push("signal " + ev.exitSignal);
  else if (ev.error) bits.push(String(ev.error));
  const d = ev.diagnostics;
  if (d && typeof d === "object") {
    bits.push("默认项来源 " + ((d.default && d.default.source) || "未读出"));
    if (d.pick === "user-preference") bits.push("按你在环境检测里选的浏览器");
    else if (d.pick === "candidate-rank") bits.push("系统未报默认项，已按候选次序取首个（可在环境检测里改）");
    else if (d.pick === "only-installed") bits.push("本机唯一候选");
    else if (d.pick === "none-found") bits.push("本机未探到可用浏览器");
    if (d.preference && d.preference.id && d.preference.matched === false) bits.push("你选的浏览器已不在候选清单，请重选");
    const found = Array.isArray(d.found) ? d.found : [];
    const cand = (f: { name?: string | null; via?: string; engine?: string | null }) =>
      (f.name || f.via || "?") + (f.engine ? "(" + f.engine + ")" : "");
    bits.push(
      "候选 " + String(found.length) + " 个" +
      (found.length ? "：" + found.map(cand).join("、") : ""),
    );
    const probed = Array.isArray(d.probed) ? d.probed : [];
    if (!found.length && probed.length) {
      bits.push("探测读数：" + probed.map((p) => p.source + (p.detail ? "=" + String(p.detail) : "")).join("、"));
    }
  }
  if (ev.via === "isolated") bits.push(ev.isolated === false ? "未隔离（并入既有窗口）" : "隔离窗口");
  if (ev.profile) bits.push("隔离档案 " + ev.profile);
  const g = ev.egress;
  if (g && typeof g === "object" && g.basis) {
    bits.push("出网判定 " + g.basis + "（" + (g.host || "未定主机") + " 代理 " + (g.proxy || "未读出") + "）");
  }
  return bits.length ? bits.join(" | ") : null;
}

export function loginIsolationText(s?: ProxyLoginStart | null): string | null {
  if (!s || s.isolated !== false) return null;
  if (s.isolatedBasis === "cold-profile-blocked") {
    return "本次登录没有用隔离窗口：" + (s.isolatedDetail || "本机直连授权域不通且没有在用代理")
      + "。已在现有浏览器窗口打开，登录完成后请手动清理账号；在系统里配好代理即可回到隔离登录。";
  }
  if (s.isolatedBasis === "engine-not-isolatable") {
    return "默认浏览器不支持隔离窗口：本次登录会带现有登录态，换账号请先在该浏览器退出";
  }
  return "本次登录未使用隔离窗口" + (s.isolatedDetail ? "：" + s.isolatedDetail : "，换账号请先在浏览器里退出");
}

export function loginUrlOf(s?: { url?: string | null; authUrl?: string | null } | null): string {
  const u = typeof s?.url === "string" && s.url ? s.url : (typeof s?.authUrl === "string" ? s.authUrl : "");
  return u.startsWith("https://") ? u : "";
}

export function classifyOpenResult(r?: OpenExternalResult | null): {
  tier: OpenTier; url: string | null; title: string; detail: string | null; reveal: boolean;
} {
  const url = typeof r?.url === "string" && r?.url ? r.url : null;
  const detail = evidenceDetail(r?.evidence);
  const ev = r?.evidence;
  const isolateIntent = !!ev && (ev.via === "isolated" || !!ev.egress);
  const msg = typeof r?.message === "string" && r.message ? r.message : null;
  const withMsg = [msg, detail].filter(Boolean).join(" | ") || null;
  if (!r || r.ok !== true) {
    return { tier: "failed", url, detail: withMsg, title: (r && r.error) || "无法调起系统浏览器，请手动打开下方地址", reveal: true };
  }
  if (r.confirmed === true) {
    return { tier: "confirmed", url, detail, title: r.message || "已在系统浏览器打开", reveal: isolateIntent };
  }
  return {
    tier: "handed-off", url, detail: withMsg, reveal: true,
    title: "已把地址交给系统，但没拿到窗口出现的证据" + (url ? "：没看到浏览器就点下方地址" : ""),
  };
}
