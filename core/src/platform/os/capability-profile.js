'use strict';

// 平台静态能力档位（纯数据）：各平台的期望声明，工具类字段由 index.js#capabilities 用 hasTool
// 实测覆写。分派留在 index.js#capabilityProfile —— cross-platform-architecture-gate CP-3 要求门面
// 显式列出三平台分支，故本表不带平台判断。
// guardAutostart/guardSelfHeal/shellAutostart/shellSelfHeal 为服务链的自启与自愈声明。
// openBrowser 为「把 http(s) 地址交给系统默认浏览器」的可用性声明：三端恒 true（Linux 由
//   capabilities() 用图形会话实测覆写），未知平台恒 false。它只声明「能不能试」，
//   真正的成败与证据档位每次调用都由 platform/os/browser.js#openBrowser 如实回报。

/** Linux 档位：期望 systemd（systemd-run/systemctl/notify-send 实测覆写）。 */
const linux = {
  // 两维拆分声明：sandboxLaunch = 能否运行实例舱；sandboxEnforcement = 限额由谁执行（cgroup|supervise|none）。
  sandboxLaunch: true,        // W3：恒可跑舱；有 systemd-run 走 cgroup 硬档，无则落 portable 软档（容器/WSL1）
  sandboxEnforcement: 'cgroup', // 期望 cgroup 硬限额；无 systemd-run 实测降 'supervise'（采样式，无内核强制）
  pidAdoption: true,
  processTreeKill: true,
  desktopNotify: true,   // 期望 notify-send（实测覆写）
  autostart: true,       // 期望 systemctl（实测覆写）
  frpExpose: true,
  openBrowser: true,     // xdg-open / 解析到的默认浏览器；无图形会话时实测覆写成 false
  hostService: 'systemd',
  guardAutostart: true,  // systemd --user enable + linger
  guardSelfHeal: true,   // unit Restart=always
  shellAutostart: true,  // 原生：XDG autostart .desktop（Exec 按实际安装解析）
  shellSelfHeal: true,   // 守卫看护（domains/shell/watchdog，三平台一套机制）
};

/** darwin 档位：期望 launchd / osascript 实测覆写。 */
const darwin = {
  sandboxLaunch: true, // portable provider（platform/os/portable.js，W3）：spawn 独立进程组 + 端口/cmdline 锚点，无需外部工具
  sandboxEnforcement: 'supervise', // 采样式限额（governor 违规处置），无内核强制——如实声明，launchd plist 一期不做
  pidAdoption: true,    // lsof
  processTreeKill: true,
  desktopNotify: true,  // 期望 osascript（实测覆写）
  autostart: true,      // launchctl/LaunchAgent 恒在
  frpExpose: true,
  openBrowser: true,    // LaunchServices 解析 + open 直启
  hostService: 'launchd',
  guardAutostart: true,  // LaunchAgent RunAtLoad + KeepAlive
  guardSelfHeal: true,   // KeepAlive
  // 壳自启 = 独立 LaunchAgent com.dsh.supervisor.gui（RunAtLoad），内核创建/删除；
  // 守卫 plist 归桌面壳建立，内核只 enable/disable + bootstrap/bootout。
  shellAutostart: true,
  shellSelfHeal: true,   // 守卫看护（三平台一套机制）
};

/** win32 档位：期望 schtasks/powershell/taskkill 实测覆写。 */
const win32 = {
  sandboxLaunch: true, // portable provider（W3）：windowsHide + CREATE_NEW_PROCESS_GROUP，整树终止走 taskkill
  sandboxEnforcement: 'supervise', // 采样式限额；Job Object 硬档一期不做不预留（届时以真机数据另立项）
  pidAdoption: true,    // netstat
  processTreeKill: true, // taskkill /PID /T /F（hasTool 覆写；使用点见 app/main/signals.js 的 _killTree）
  desktopNotify: true,   // 期望 powershell（实测覆写）
  autostart: true,       // 期望 schtasks（实测覆写）
  frpExpose: true,
  // 可打开，但 Windows 没有可信调度器（系统调度器只有 darwin 的 open 与 linux 的 xdg-open），
  // 只能直启探测层解析出的浏览器本体；浏览器已在运行时本次进程只转交地址，退出码与窗口出现与否无关，
  // 故该平台每次调用最多到 handedOff（判据见 browser.js#ownsItsWindow）。能力位只声明「能交出去」。
  openBrowser: true,
  hostService: 'windows-service',
  guardAutostart: true,  // schtasks DSH-Supervisor（ONLOGON，由壳建立）
  guardSelfHeal: true,   // schtasks DSH-Supervisor-Watchdog 每 5 分钟（同样归壳，内核只查询存在性）
  shellAutostart: true,  // schtasks DSH-Supervisor-GUI（ONLOGON，内核 setAutostart 创建）
  // 壳的自愈依赖那条 watchdog 任务，故与 guardSelfHeal 同前提：登录自启未启用时无从检查。
  shellSelfHeal: true,
};

/** 未知平台档位：全能力 false，hostService=none（显式失败，不谎报）。
 *  未受支持的平台（含无任何图形会话的移动/嵌入式宿主）一律 false：外部打开能力在此显式关闭，
 *  调用方拿到 ok:false/reason 后必须把地址交给用户自行处理。 */
const unknown = {
  sandboxLaunch: false, sandboxEnforcement: 'none',
  pidAdoption: false, processTreeKill: false,
  desktopNotify: false, autostart: false, frpExpose: false,
  openBrowser: false,
  hostService: 'none',
  guardAutostart: false, guardSelfHeal: false,
  shellAutostart: false, shellSelfHeal: false,
};

module.exports = { linux, darwin, win32, unknown };
