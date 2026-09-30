/** 面板侧「把地址交给系统浏览器」的唯一入口（结果如何呈现的唯一出口在 openExternal.tsx）。
 *
 *  为什么面板还要选路：面板由内核自己托管，故「页面来源是否回环」等价于「看面板的浏览器与内核是否
 *  同一台机器」。同一台机器时打开动作**必须**由内核执行 —— 桌面壳的 webview 丢弃 window.open 与
 *  target=_blank（旧形态表现为按钮毫无反应），且只有内核能给出三档证据。不同机器时（局域网/公网访问者）
 *  内核无法打开访客自己的浏览器，只剩访客浏览器的原生新标签。
 *  两条路的结局一律归一成 OpenExternalResult，界面上不存在第二种说法。
 */
import { supervisorApi } from "./client";
import type { OpenExternalResult, ProxyLoginStart } from "./types";

/** 面板是否由本机内核托管；与内核 /env/open-url 的 identity.loopback 判的是同一件事。
 *  回环 IPv4 按四段整体匹配：`^127.` 这种前缀判据会把 `127.example.com` 也认成本机，
 *  而内核侧按真实 socket 判回环，误判只会让远程访客的面板把动作推给内核、换回一次 403。 */
export function servedByKernelHost(): boolean {
  const h = String(window.location.hostname || "").toLowerCase();
  return h === "localhost" || h === "[::1]" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** 访客自己的浏览器（非回环来源）：被弹窗拦截时 open 返回 null，那是失败不是成功。
 *  用户手势内拿到窗口句柄即浏览器接收了导航（新标签就在访客眼前），故算 confirmed，
 *  但证据只到「浏览器认了这条路」，不得冒领内核那一侧的进程退出取证。 */
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

/** 用户在面板里点一条地址时的统一入口：本机内核托管则请内核开浏览器，否则用访客自己的浏览器。
 *  内核侧失败（非 2xx）由调用方 runOpenExternal 的 catch 取 err.body，三档字段与地址都不丢。 */
export async function handOffFromPanel(url: string): Promise<OpenExternalResult> {
  if (!url) return { ok: false, error: "没有可打开的地址" };
  if (servedByKernelHost()) return supervisorApi.envOpenUrl(url);
  return openViaWindow(url);
}

export type OpenTier = "confirmed" | "handed-off" | "failed";

/** 启动形态 + 探测留痕摊成一行小字：三档里 handedOff 与 failed 的区别只在证据强弱，用户需要知道自己点了什么
 *  才知道该不该信这句结论 —— 内核把 bin/via/ownsWindow/exit 一并交出，此前它在响应体里躺着没人看。
 *  diagnostics 是探测层留痕的行内摘要（默认项从哪条系统事实读出、本机探到哪些候选）：
 *  「点了没弹出来」这一类报障，只有带着这一行才谈得上定性，否则界面永远只剩一句「再点一次」。 */
export function evidenceDetail(ev?: OpenExternalResult["evidence"]): string | null {
  if (!ev || typeof ev !== "object") return null;
  const exe = typeof ev.bin === "string" ? ev.bin.split(/[\\/]/).pop() : null;
  const bits: string[] = [];
  if (exe) bits.push(exe);
  else if (ev.via === "none") bits.push("未定出启动对象");
  if (ev.via) bits.push(ev.via);
  // 引擎是「能不能开隔离窗」的直接线索（chromium/firefox 有隔离方言，webkit 与打包器包装没有）：
  //   白窗口报障只有摊出引擎才谈得上分「换浏览器」还是「配代理」，内核交出而界面不读等于没交。
  if (ev.engine) bits.push("引擎 " + ev.engine);
  if (ev.ownsWindow === false) bits.push("退出码不作证据");
  if (ev.watch === true) bits.push("关掉该窗口即取消本次登录");
  if (ev.exitCode !== undefined && ev.exitCode !== null) bits.push("exit " + String(ev.exitCode));
  else if (ev.exitSignal) bits.push("signal " + ev.exitSignal);
  else if (ev.error) bits.push(String(ev.error));
  const d = ev.diagnostics;
  if (d && typeof d === "object") {
    bits.push("默认项来源 " + ((d.default && d.default.source) || "未读出"));
    // 分发依据要说人话：用户最需要知道的是「这次用的是不是我选的那个」，而不是内核内部的来源名。
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
    // 零候选时留痕就是唯一的现场：只报行名等于说「系统答了但没说答了什么」，detail 必须一起出。
    if (!found.length && probed.length) {
      bits.push("探测读数：" + probed.map((p) => p.source + (p.detail ? "=" + String(p.detail) : "")).join("、"));
    }
  }
  if (ev.via === "isolated") bits.push(ev.isolated === false ? "未隔离（并入既有窗口）" : "隔离窗口");
  // 冷档案目录随行：白窗口最可能的解释就住在这个目录里（首次启动、扩展为零），报障时要能把路径给支持看。
  if (ev.profile) bits.push("隔离档案 " + ev.profile);
  // 出网判定结论码：降级是内核依表单事实做的决定，界面必须说清依据哪一条，否则「为什么没隔离」只剩猜。
  const g = ev.egress;
  if (g && typeof g === "object" && g.basis) {
    bits.push("出网判定 " + g.basis + "（" + (g.host || "未定主机") + " 代理 " + (g.proxy || "未读出") + "）");
  }
  return bits.length ? bits.join(" | ") : null;
}

/** 一键登录的隔离结论说明（纯函数，页面只渲染它给的句子或 null）。
 *  「未隔离」有两种完全不同的原因：引擎根本没有隔离方言（只能换浏览器），或本机往目标域没有出网路、
 *  冷档案窗口注定是空白页（配好系统代理即可回到隔离档）。合成一句就把可修的那一半说丢了。 */
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

/** 等待授权期间面板要常驻的那一行地址（纯函数，页面不自己取字段）。
 *  同一地址内核放在 url（三档词汇必备）与 authUrl（登录专有）两处，取数口径只能有一处；
 *  产物会被渲染成可点链接且来自 HTTP 响应，故非 https 一律不摊。 */
export function loginUrlOf(s?: { url?: string | null; authUrl?: string | null } | null): string {
  const u = typeof s?.url === "string" && s.url ? s.url : (typeof s?.authUrl === "string" ? s.authUrl : "");
  return u.startsWith("https://") ? u : "";
}

/** 结果分档（纯函数）：三档语义在此唯一一次映射为界面档位。
 *  判据取 ok/confirmed，不取 message/error 文本 —— 文案可变，档位是契约。
 *  reveal = 这一档要不要把证据行摊到屏幕上，与服务层的分档同处判定：组件只做渲染，
 *  「白窗口现场该看见什么」这种取舍写在组件里就没法在 CI 里判红。 */
export function classifyOpenResult(r?: OpenExternalResult | null): {
  tier: OpenTier; url: string | null; title: string; detail: string | null; reveal: boolean;
} {
  const url = typeof r?.url === "string" && r?.url ? r.url : null;
  const detail = evidenceDetail(r?.evidence);
  // confirmed 档一般不必摊细节（证据已经说完了），隔离登录意图例外：真机那句「弹了但是白窗口」
  //   最可能就落在 confirmed —— 屏幕上没有「交给谁 / 什么引擎 / 出网判定」这一行，取证只剩玄学。
  //   判据用 via/egress 而不是意图参数：egress 非空即「这一拍真的判过冷档案出网」，降档那条也算。
  const ev = r?.evidence;
  const isolateIntent = !!ev && (ev.via === "isolated" || !!ev.egress);
  // 内核给出 message 的非确认档（如冷档案降档：已在既有窗口打开 + 该怎么收尾）必须上屏。
  //   confirmed 档把 message 当标题，另两档标题是固定的契约句，故 message 并进细节行 ——
  //   丢掉它就等于「内核解释了原因，界面上却只剩一句没拿到证据」。
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
