// 面板侧「把地址交给浏览器」的行为测试。病根是静默的：内核说「只是把地址交了出去」，
// 面板却显示成功（或反过来把地址丢掉，用户只能重复点击）。形态门禁（platform-layer-portability X-11）
// 只能证明源码里有这些字样，证不了分档判据按字段而非文案走、也证不了选路判据成立，故这里按行为钉。
// 与 client.test.ts 同一手法：注入 fetch 替身，测到真实请求的路径与请求体，不碰 supervisorApi 本身。
import { afterEach, describe, expect, it, vi } from "vitest";
import { handOffFromPanel, openViaWindow, servedByKernelHost, classifyOpenResult, evidenceDetail, loginIsolationText, loginUrlOf } from "./externalOpen";
import type { ProxyLoginStart } from "./types";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } } as ResponseInit);
}

/** 内核 /env/open-url 的替身：记下面板发出的路径与请求体（选路判据的行为证据），按给定档位回。 */
function stubKernel(status: number, body: unknown) {
  const sent: Array<{ path: string; payload: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    sent.push({ path: String(url), payload: JSON.parse(String(init?.body)) });
    return Promise.resolve(jsonResponse(status, body));
  }));
  return sent;
}

/** 装一个最小 window：hostname 决定面板由谁托管；open 记录访客浏览器的原生新标签。
 *  blocked=弹窗被拦截（浏览器回 null），throws=导航被策略拒绝。 */
function installWindow(hostname: string, behavior: "accept" | "blocked" | "throws" = "accept") {
  const calls: string[][] = [];
  const win: Record<string, unknown> = {
    location: { hostname },
    open: (...args: unknown[]) => {
      calls.push(args.map(String));
      if (behavior === "throws") throw new Error("blocked by policy");
      return behavior === "blocked" ? null : { closed: false };
    },
  };
  vi.stubGlobal("window", win as unknown as Window & typeof globalThis);
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("classifyOpenResult：三档只看字段，不看文案", () => {
  it("confirmed 才升为「已打开」档", () => {
    const r = classifyOpenResult({ ok: true, confirmed: true, handedOff: false, url: "http://127.0.0.1:1/open?code=c" });
    expect(r.tier).toBe("confirmed");
    expect(r.url).toBe("http://127.0.0.1:1/open?code=c");
  });

  it("反向：文案谎称已打开但 confirmed 缺失 -> 仍是 handed-off（判据取字段即不被文案带跑）", () => {
    const r = classifyOpenResult({ ok: true, confirmed: false, handedOff: true, message: "已在系统浏览器打开", url: "http://a.b/" });
    expect(r.tier).toBe("handed-off");
    expect(r.title).not.toBe("已在系统浏览器打开");
  });

  it("ok:false 一律 failed，且带上给用户的说法与地址", () => {
    const r = classifyOpenResult({ ok: false, reason: "no-launcher", error: "未找到可用的浏览器启动命令", url: "http://a.b/" });
    expect(r.tier).toBe("failed");
    expect(r.title).toContain("未找到");
    expect(r.url).toBe("http://a.b/");
  });

  it("结果整体缺失也是 failed（不得因 undefined 冒充实成功）", () => {
    expect(classifyOpenResult(null).tier).toBe("failed");
    expect(classifyOpenResult(undefined).url).toBe(null);
  });
  it("降档理由必须随非确认档上桌（内核解释了为什么没用隔离窗，界面丢掉那句话等于没说）", () => {
    const r = classifyOpenResult({ ok: true, confirmed: false, handedOff: true, url: "http://a.b/", message: "隔离窗口会是空白页" });
    expect(r.tier).toBe("handed-off");
    expect(r.detail).toContain("隔离窗口会是空白页");
  });
  it("摊不摊证据行的取舍：非确认档恒摊，confirmed 只给隔离登录意图摊", () => {
    // 普通打开（点自己地址行那种高频动作）成功时不摊，免得屏幕长期挂一行技术字。
    expect(classifyOpenResult({ ok: true, confirmed: true, url: "http://a.b/",
      evidence: { bin: "firefox", via: "browser", ownsWindow: false, exitCode: 0 } }).reveal).toBe(false);
    // 隔离登录成功档正是白窗口的落点：没有这一行，真机取证只剩「弹了但空白」。
    expect(classifyOpenResult({ ok: true, confirmed: true, url: "http://a.b/",
      evidence: { bin: "chrome", via: "isolated", engine: "chromium", ownsWindow: true, exitCode: 0, watch: true } }).reveal).toBe(true);
    // 降档那条 via 已不是 isolated，但 egress 非空即「这一拍真的判过冷档案出网」，同样要摊。
    expect(classifyOpenResult({ ok: true, confirmed: true, url: "http://a.b/",
      evidence: { bin: "chrome", via: "browser", exitCode: 0, egress: { host: "login.example.test", viable: false, basis: "cold-profile-blocked", proxy: "off" } } }).reveal).toBe(true);
    expect(classifyOpenResult({ ok: true, confirmed: true, url: "http://a.b/",
      evidence: { bin: "chrome", via: "browser", exitCode: 0, egress: { host: "login.example.test", viable: false, basis: "cold-profile-blocked", proxy: "off" } } }).detail)
      .toContain("出网判定 cold-profile-blocked");
    // 反向：失败/交给系统两档即使没有证据也必须摊（摊的是「有没有拿到东西」，不是「拿到什么」）
    expect(classifyOpenResult({ ok: false, error: "未找到" }).reveal).toBe(true);
    expect(classifyOpenResult({ ok: true, confirmed: false, handedOff: true }).reveal).toBe(true);
  });
});

describe("loginIsolationText：「没用隔离窗口」的两种原因分不开，用户就不知道下一步做什么", () => {
  it("反向：隔离成功与结果缺失都不给提示（把正常档写成提醒就是噪声）", () => {
    expect(loginIsolationText({ ok: true, isolated: true })).toBe(null);
    expect(loginIsolationText(null)).toBe(null);
    expect(loginIsolationText({ ok: true })).toBe(null);
  });
  it("冷档案注定空白 -> 说清依据并给出可修的那一半（配好系统代理即回到隔离档）", () => {
    // 类型标注不是装饰：它把「面板读的这三个字段确实在内核契约里」钉成编译期判据，
    //   内核改名或漏字段时这里先红，而不是到真机上才发现提示永远是兜底那句。
    const s: ProxyLoginStart = {
      ok: true, isolated: false, isolatedBasis: "cold-profile-blocked",
      isolatedDetail: "login.example.test 直连不通且系统没有在用代理",
    };
    const t = loginIsolationText(s);
    expect(t).toContain("login.example.test 直连不通");
    expect(t).toContain("配好代理");
    expect(t).toContain("手动清理账号");
  });
  it("引擎没有隔离方言 -> 只说换浏览器，不得混进代理那条说法（两种原因的处置相反）", () => {
    const t = loginIsolationText({ ok: true, isolated: false, isolatedBasis: "engine-not-isolatable" });
    expect(t).toContain("不支持隔离窗口");
    expect(t).not.toContain("代理");
  });
  it("依据码缺失时给一句兜底而不是什么都不显示", () => {
    const t = loginIsolationText({ ok: true, isolated: false });
    expect(t).toContain("未使用隔离窗口");
  });
});

describe("loginUrlOf：等待授权期间常驻的地址行（toast 十几秒就消失，用户的出路不能跟着消失）", () => {
  it("优先取三档词汇的 url，缺失时回退登录专有的 authUrl", () => {
    expect(loginUrlOf({ url: "https://commandcode.test/a", authUrl: "https://stale.test/b" }))
      .toBe("https://commandcode.test/a");
    const s: ProxyLoginStart = { ok: false, authUrl: "https://commandcode.test/c" };
    expect(loginUrlOf(s)).toBe("https://commandcode.test/c");
  });
  it("反向：地址缺失或非 https 一律不摊 —— 这一行会被渲染成可点链接，且面板地址带着访问令牌", () => {
    expect(loginUrlOf(null)).toBe("");
    expect(loginUrlOf({ url: "" })).toBe("");
    expect(loginUrlOf({ url: "javascript:void0" })).toBe("");
    expect(loginUrlOf({ url: "data:text/html,%3Cscript%3E" })).toBe("");
    expect(loginUrlOf({ authUrl: "http://127.0.0.1:3080/?token=secret" })).toBe("");
  });
});

describe("evidenceDetail：把启动形态摊给用户（真机报错只有文案时无人能定位）", () => {
  it("不可信形态标注「退出码不作证据」，并可执行文件名而非全路径", () => {
    // Windows 只剩「直启探测解析出的本体」这一种形态（那条向系统 shell 冒开的路已整体删除），
    //   而它可被既有实例吸收，故退出码两个方向都不是证据。
    expect(evidenceDetail({ bin: "C:\\Windows\\System32\\notepad.exe", via: "browser", ownsWindow: false, exitCode: 1 }))
      .toBe("notepad.exe | browser | 退出码不作证据 | exit 1");
  });
  it("可信形态只报退出码；只剩 error 码时报 error 码", () => {
    expect(evidenceDetail({ bin: "xdg-open", via: "dispatcher", ownsWindow: true, exitCode: 3 })).toBe("xdg-open | dispatcher | exit 3");
    expect(evidenceDetail({ bin: "xdg-open", via: "dispatcher", ownsWindow: true, error: "ENOENT" })).toBe("xdg-open | dispatcher | ENOENT");
  });
  it("反向：ownsWindow 缺失（旧内核结果）不得凭空标注证据规则", () => {
    expect(evidenceDetail({ bin: "open", via: "dispatcher", exitCode: 0 })).toBe("open | dispatcher | exit 0");
    expect(evidenceDetail(null)).toBe(null);
    expect(evidenceDetail({})).toBe(null);
  });
  it("探测诊断随行摊出：默认项从哪条系统事实读出 + 本机探到哪些候选", () => {
    const detail = evidenceDetail({
      bin: "C:\\Program Files\\Mozilla Firefox\\firefox.exe", via: "browser", ownsWindow: false, exitCode: 0,
      diagnostics: {
        pick: "userchoice",
        default: { id: "c:\\program files\\mozilla firefox\\firefox.exe", source: "userchoice" },
        found: [{ name: "Firefox", engine: "firefox", via: "userchoice" }, { name: "MSEdge", engine: "chromium", via: "startmenu-catalog" }],
        probed: [{ source: "userchoice", detail: "Firefox" }],
      },
    });
    expect(detail).toBe("firefox.exe | browser | 退出码不作证据 | exit 0 | 默认项来源 userchoice | 候选 2 个：Firefox(firefox)、MSEdge(chromium)");
  });
  it("引擎随行摊出：白窗口要能分「换浏览器」还是「配代理」，内核交出而界面不读等于没交", () => {
    const d = evidenceDetail({ bin: "/usr/bin/safari", via: "browser", engine: "webkit", ownsWindow: true, exitCode: 0 });
    expect(d).toContain("引擎 webkit");
    // 反向：旧内核不交 engine 时不得凭空造出引擎字样（造出来就是把猜测投上屏幕）
    expect(evidenceDetail({ bin: "/usr/bin/safari", via: "browser", ownsWindow: true, exitCode: 0 })).not.toContain("引擎");
  });
  it("关窗即取消要说明：隔离登录的窗口关掉等于放弃，用户不知道就会继续等回调", () => {
    const d = evidenceDetail({ bin: "/usr/bin/chrome", via: "isolated", ownsWindow: true, watch: true, isolated: true, exitCode: 0 });
    expect(d).toContain("关掉该窗口即取消本次登录");
    // 反向：并入既有窗口（watch 不为真）时不得宣称关窗能取消——那会把用户的既有会话当成可弃的
    expect(evidenceDetail({ bin: "/usr/bin/chrome", via: "isolated", ownsWindow: true, isolated: false, exitCode: 0 }))
      .not.toContain("关掉该窗口");
  });
  it("冷档案目录摊出来：白窗口的解释多半在这个目录里，支持排障要能直接拿到路径", () => {
    const d = evidenceDetail({ bin: "/usr/bin/chrome", via: "isolated", isolated: true, profile: "/tmp/dsh-login-a1b2", exitCode: 0 });
    expect(d).toContain("隔离档案 /tmp/dsh-login-a1b2");
    // 反向：普通打开没有目录（profile 为 null），不许凭空造出一行档案路径
    expect(evidenceDetail({ bin: "/usr/bin/chrome", via: "browser", profile: null, exitCode: 0 })).not.toContain("隔离档案");
  });
  it("选不出启动对象时把「哪条来源答了什么」摊出来（否则与探测层失灵无从区分）", () => {
    const detail = evidenceDetail({
      bin: null, via: "none", ownsWindow: false,
      diagnostics: {
        pick: "none-found", default: null, found: [],
        probed: [{ source: "userchoice", detail: "empty" }, { source: "app-paths", detail: "指向的文件不可执行" }],
      },
    });
    expect(detail).toBe("未定出启动对象 | none | 退出码不作证据 | 默认项来源 未读出 | 本机未探到可用浏览器 | 候选 0 个 | 探测读数：userchoice=empty、app-paths=指向的文件不可执行");
  });
  it("分发依据说人话：四层各有一句，用户据此知道这次用的是不是自己选的那个", () => {
    const say = (pick: string, pref?: { id: string; matched: boolean }) => evidenceDetail({
      bin: "/usr/bin/firefox", via: "browser", ownsWindow: false, exitCode: 0,
      diagnostics: { pick, default: null, preference: pref || null, found: [{ name: "Firefox" }], probed: [] },
    });
    expect(say("user-preference")).toContain("按你在环境检测里选的浏览器");
    expect(say("candidate-rank")).toContain("系统未报默认项，已按候选次序取首个（可在环境检测里改）");
    expect(say("only-installed")).toContain("本机唯一候选");
    expect(say("none-found")).toContain("本机未探到可用浏览器");
    // 反向：系统报出的默认项来源名不是这四档之一，不得被说成「按你选的」——否则用户会以为是自己定的
    expect(say("userchoice")).not.toContain("按你在环境检测里选的浏览器");
    // 偏好所指已被卸载/路径失效：必须点名「不在候选清单」，只报回落等于让用户继续等一个不会来的窗口
    expect(say("userchoice", { id: "c:\\gone\\firefox.exe", matched: false }))
      .toContain("你选的浏览器已不在候选清单，请重选");
    expect(say("userchoice", { id: "/usr/bin/firefox", matched: true })).not.toContain("请重选");
  });
  it("隔离窗口把「隔没隔」写进形态：并入既有窗口时不许留「隔离」二字", () => {
    expect(evidenceDetail({ bin: "/usr/bin/chrome", via: "isolated", ownsWindow: true, exitCode: 0, isolated: true }))
      .toBe("chrome | isolated | exit 0 | 隔离窗口");
    expect(evidenceDetail({ bin: "/usr/bin/safari", via: "isolated", ownsWindow: true, exitCode: 0, isolated: false }))
      .toBe("safari | isolated | exit 0 | 未隔离（并入既有窗口）");
  });
  it("反向：旧内核不带 diagnostics 时不得凭空造出探测结论", () => {
    expect(evidenceDetail({ bin: "/usr/bin/chromium", via: "browser", ownsWindow: false, exitCode: 0 }))
      .toBe("chromium | browser | 退出码不作证据 | exit 0");
  });
  it("handed-off 档带着证据细节也不升成成功说法", () => {
    const r = classifyOpenResult({
      ok: true, confirmed: false, handedOff: true, url: "http://a.b/",
      evidence: { bin: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", via: "browser", ownsWindow: false, exitCode: 1 },
    });
    expect(r.tier).toBe("handed-off");
    expect(r.detail).toBe("msedge.exe | browser | 退出码不作证据 | exit 1");
  });
  it("出网判定进证据行（这次隔离窗为什么开/为什么没开，屏幕上要有一行依据而不是一句玄学）", () => {
    const d = evidenceDetail({
      bin: "/usr/bin/google-chrome", via: "browser", isolated: false, exitCode: 0,
      egress: { host: "login.example.test", viable: false, basis: "cold-profile-blocked", proxy: "off" },
    });
    expect(d).toContain("出网判定 cold-profile-blocked");
    expect(d).toContain("login.example.test 代理 off");
  });
  it("反向：内核没交出出网结论时不得凭空造出一行判定", () => {
    expect(evidenceDetail({ bin: "/usr/bin/google-chrome", via: "browser", exitCode: 0 })).not.toContain("出网判定");
  });
});

describe("servedByKernelHost：浏览器与内核是否同一台机器", () => {
  for (const h of ["127.0.0.1", "localhost", "LOCALHOST", "[::1]", "::1", "127.5.1.1"]) {
    it(h + " 判为回环", () => {
      installWindow(h);
      expect(servedByKernelHost()).toBe(true);
    });
  }
  // 127.example.com 是「以 127. 开头」这种前缀判据的漏网之鱼：它不是 IP，内核在那台机器上，
  //   误判会让远程访客的面板把动作推给内核，而内核按真实 socket 判非回环 —— 用户只看到一次 403。
  for (const h of ["192.168.1.20", "dsh.example.com", "127.example.com", "127.0.0.1.evil.com", "[::2]", ""]) {
    it("反向：" + h + " 不是回环，此时请内核开浏览器是在别人的机器上弹窗", () => {
      installWindow(h);
      expect(servedByKernelHost()).toBe(false);
    });
  }
});

describe("handOffFromPanel：本机请内核开、他人浏览器自己开", () => {
  it("回环来源走内核端点，且原样交出三档结果（不另造成败说法）", async () => {
    const w = installWindow("127.0.0.1");
    const sent = stubKernel(200, { ok: true, confirmed: true, handedOff: false, url: "http://127.0.0.1:1/open?code=c", evidence: { bin: "xdg-open" } });
    const r = await handOffFromPanel("http://127.0.0.1:1/open?code=c");
    expect(sent).toEqual([{ path: "/env/open-url", payload: { url: "http://127.0.0.1:1/open?code=c" } }]);
    expect(w.calls.length).toBe(0);
    expect(r.confirmed).toBe(true);
    expect(r.evidence?.bin).toBe("xdg-open");
  });

  it("内核的失败档随 err.body 原样抛出（呈现口据此取回地址与 reason）", async () => {
    installWindow("localhost");
    stubKernel(500, { ok: false, reason: "no-launcher", url: "http://a.b/" });
    const e = await handOffFromPanel("http://a.b/").then(() => null, (x: unknown) => x as { body?: { reason?: string; url?: string } });
    expect(e?.body?.reason).toBe("no-launcher");
    expect(e?.body?.url).toBe("http://a.b/");
  });

  it("非回环来源用访客自己的浏览器：不得把动作推给内核", async () => {
    const w = installWindow("192.168.1.20");
    const sent = stubKernel(200, { ok: true, confirmed: true });
    const r = await handOffFromPanel("http://a.b/");
    expect(sent.length).toBe(0);
    expect(w.calls.length).toBe(1);
    expect(r.ok).toBe(true);
    // 新标签就在访客眼前，故算 confirmed；证据只到「浏览器接收了导航」，不冒领内核的进程取证。
    expect(r.confirmed).toBe(true);
    expect(r.evidence?.via).toBe("window");
  });

  it("没有地址时不发起任何动作", async () => {
    const w = installWindow("192.168.1.20");
    const sent = stubKernel(200, { ok: true, confirmed: true });
    const r = await handOffFromPanel("");
    expect(r.ok).toBe(false);
    expect(w.calls.length).toBe(0);
    expect(sent.length).toBe(0);
  });
});

describe("openViaWindow：弹窗被拦截是失败，不是成功", () => {
  it("带 noopener（不得把面板 window 引用交给被打开页）", () => {
    const w = installWindow("192.168.1.20");
    openViaWindow("http://a.b/");
    expect(w.calls[0]?.[2]).toContain("noopener");
  });

  it("返回 null -> ok:false 并说明是拦截，地址仍在场", () => {
    const w = installWindow("192.168.1.20", "blocked");
    const r = openViaWindow("http://a.b/");
    expect(w.calls.length).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.url).toBe("http://a.b/");
    expect(r.error || "").toContain("拦截");
  });

  it("抛错也归一成结果对象（异常不得绕过唯一呈现口）", () => {
    const w = installWindow("192.168.1.20", "throws");
    const r = openViaWindow("http://a.b/");
    expect(w.calls.length).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.error || "").toContain("blocked by policy");
  });
});
