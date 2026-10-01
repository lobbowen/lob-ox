#!/usr/bin/env node
'use strict';

// 测试登记表 —— test/_runner.js 读取后逐条起子进程执行。
//   tier 决定选跑范围：CI 矩阵腿只跑 --tier=L2，L1 只在 ubuntu 的 test job 跑一遍 ⇒ 有真宿主依赖却标 L1
//   等于该回归在 win32/darwin 永不执行。os 列出的宿主才跑，其余由 gaps() 汇总成 SKIP 台账。

const ENTRIES = [
  { file: "test/relay-dshauth-test.js", tier: "L2", os: "all", why: "起真 HTTP 中继（原标 L1 与实现不符 ⇒ win32/darwin 不跑）" },
  { file: "test/task-registry-test.js", tier: "L1", os: "all", why: "纯逻辑：跨进程丢失更新的唯一防线" },
  { file: "test/managed-registry-test.js", tier: "L1", os: "all", why: "纯逻辑：目录登记/申报/相位推导" },
  { file: "test/smoke.js", tier: "L2", os: "all", why: "起真 daemon 子进程 + 端口轮询" },
  { file: "test/upgrade-test.js", tier: "L2", os: "all", why: "真起 daemon 走升级回滚" },
  { file: "test/governor-test.js", tier: "L1", os: "all", why: "纯逻辑：资源治理决策" },
  { file: "test/frp-platform-test.js", tier: "L1", os: "all", why: "纯逻辑：frp 官方资产名映射（外部契约）" },
  { file: "test/instance-state-test.js", tier: "L2", os: "all", why: "真 net listen + 真起子进程（原标 L1）" },
  { file: "test/ports-claim-test.js", tier: "L2", os: "all", why: "真 listen + 跨进程子进程（原标 L1）" },
  { file: "test/ports-migrate-test.js", tier: "L2", os: "linux,darwin", why: "chmod 语义按 POSIX 断言" },
  { file: "test/ports-verify.js", tier: "L2", os: "all", why: "真 spawn 子进程（原标 L1）" },
  { file: "test/precheck-test.js", tier: "L1", os: "all", why: "未安装分支的唯一防线" },
  { file: "test/router-test.js", tier: "L2", os: "all", why: "真 listen（上游 127.0.0.1:3993 + 供应商 API 端口）+ 一账号一实例 + Key 池故障转移（原标 L1 ⇒ 只在 ubuntu 跑）" },
  { file: "test/router-e2e-test.js", tier: "L2", os: "all", why: "真 listen + 真 SSE + 真用量（原标 L1）" },
  { file: "test/reconcile-instance-test.js", tier: "L2", os: "all", why: "真 listen + 多次子进程 spawn + SIGKILL" },
  { file: "test/upstream-credits-test.js", tier: "L1", os: "all", why: "纯逻辑：上游额度与冻结/解冻面" },
  { file: "test/freeze-recovery-test.js", tier: "L2", os: "all", why: "真 listen（原标 L1）" },
  { file: "test/main-port-rederive-test.js", tier: "L2", os: "all", why: "真 spawn（原标 L1）" },
  { file: "test/adopt-token-reclaim-test.js", tier: "L2", os: "all", why: "凭据否决接管 / cmdline 不误杀（os 原为 linux,darwin ⇒ win32 无保护）" },
  { file: "test/router-ctl-test.js", tier: "L2", os: "all", why: "真 listen（原标 L1）" },
  { file: "test/daemon-lifecycle-test.js", tier: "L2", os: "all", why: "孤儿回收/换代/原子锁三条真进程回归（os 原为 linux,darwin）" },
  { file: "test/lan-daemon-test.js", tier: "L2", os: "all", why: "detached 真守护 + 退出码" },
  { file: "test/token-boundary-test.js", tier: "L1", os: "all", why: "纯逻辑：令牌边界与落盘剔除" },
  { file: "test/loghub-test.js", tier: "L2", os: "all", why: "真 listen 事件流（原标 L1）" },
  { file: "test/api-fuzz-test.js", tier: "L2", os: "all", why: "真 socket 安全回归（os 原为 linux,darwin）" },
  { file: "test/monthly-credits-freeze-test.js", tier: "L1", os: "all", why: "纯逻辑：月度额度冻结" },
  { file: "test/ports-capacity-test.js", tier: "L2", os: "linux", why: "读 /proc 判 ephemeral 重叠（⚠️ 非 Linux 上该判据退化恒真 ⇒ 不得扩 all，否则假绿）" },
  { file: "test/session-lifecycle-test.js", tier: "L1", os: "all", why: "纯逻辑：会话启停决策" },
  { file: "test/sigterm-desired-test.js", tier: "L2", os: "linux,darwin", why: "pkill + SIGTERM 真进程" },
  { file: "test/managed-lifecycle-failure-test.js", tier: "L1", os: "all", why: "纯逻辑：显式失败语义（已并入原 round13-lifecycle-stop-phase）" },
  { file: "test/shadow-decision-test.js", tier: "L1", os: "all", why: "纯逻辑：影子决策（无 IO）" },
  { file: "test/uninstall-timeout-behavior-test.js", tier: "L1", os: "all", why: "注入 npmBin 的超时行为面" },
  { file: "test/lan-access-boundary-test.js", tier: "L1", os: "all", why: "纯逻辑：LAN 边界准入矩阵" },
  { file: "test/reconcile-single-flight-test.js", tier: "L1", os: "all", why: "纯逻辑：单飞复用" },
  { file: "test/instance-systemd-aside-behavior-test.js", tier: "L1", os: "all", why: "真 mkdtemp + 注入假 service" },
  { file: "test/watchdog-phase-freshness-test.js", tier: "L1", os: "all", why: "注入时钟 + 桩 identity/pidlookup" },
  { file: "test/market-budget-test.js", tier: "L1", os: "all", why: "真 tmp 目录 + 注入计时器" },
  { file: "test/daemon-path-test.js", tier: "L1", os: "all", why: "真调原型方法 + 真 FS 存在性" },
  { file: "test/app-ctor-injection-test.js", tier: "L1", os: "all", why: "注入工厂：state/config 持久化面（拆分后只装 state）" },
  { file: "test/exec-return-contract-test.js", tier: "L2", os: "all", why: "真跑 node 子进程；A7 守 win32 npm.cmd EINVAL 同步抛（os 原为 linux ⇒ 该回归在 Windows 无人验）" },
  { file: "test/version-vectors-test.js", tier: "L1", os: "all", why: "真跑 VERSION_RE/semverCompare 对共享向量" },
  { file: "test/release-channel-test.js", tier: "L1", os: "all", why: "纯逻辑：选版链" },
  { file: "test/frp-resilience-test.js", tier: "L2", os: "linux,darwin", why: "sh 假 frpc 脚本重启退避" },
  { file: "test/round13-frpc-integrity-test.js", tier: "L1", os: "all", why: "纯逻辑：frpc 完整性校验路径" },
  { file: "test/shell-watchdog-test.js", tier: "L1", os: "all", why: "纯函数 decide() + 注入 mock/假时钟" },
  { file: "test/shell-watchdog-e2e-test.js", tier: "L2", os: "all", why: "真 start() 拉起假壳进程" },
  { file: "test/shell-safety-net-test.js", tier: "L2", os: "all", why: "含专为 win32 修的分支与 exePath 夹具（原标 L1 ⇒ 在 Windows 永不执行）" },
  { file: "test/platform-matrix-single-source-test.js", tier: "L1", os: "all", why: "纯函数 npmTag/osTag/frpTag + 清单对账" },
  { file: "test/destructive-op-safety-test.js", tier: "L2", os: "linux,darwin", why: "chmod/字节哈希在真 FS 上（真机令牌唯一字节级防线）" },
  { file: "test/credential-hygiene-test.js", tier: "L2", os: "linux,darwin", why: "cred.sh 子进程 + 0700 位" },
  { file: "test/platform-parsers-and-commands-test.js", tier: "L2", os: "all", why: "真 node -e 子进程 + 真 FS 探测（原标 L1）" },
  { file: "test/platform-layer-portability-test.js", tier: "L2", os: "all", why: "真 listen/spawn 的服务与自启层（拆分后保留此面）" },
  { file: "test/four-platform-behavior-matrix-test.js", tier: "L2", os: "all", why: "四平台行为矩阵（原标 L1 ⇒ 只在 ubuntu 跑，与「四平台」自相矛盾）+ P-6 arch 契约" },
  { file: "test/api-contract-test.js", tier: "L2", os: "all", why: "真 HTTP 服务与真 socket 契约（原标 L1）" },
  { file: "test/plugin-change-restart-test.js", tier: "L1", os: "all", why: "桩 CLI/instances + 真临时 profile 目录" },
  { file: "test/runtime-contract-test.js", tier: "L1", os: "all", why: "契约读取器行为（原标 L1 保留：无真宿主依赖）" },
  { file: "test/native-dsh-binding-test.js", tier: "L1", os: "all", why: "注入 NativeManager：绑定/认领契约" },
  { file: "test/install-id-test.js", tier: "L2", os: "all", why: "node -e 子进程 + installId 防漂移（os 原为 linux,darwin ⇒ win32 零验证）" },
  { file: "test/switch-policies-test.js", tier: "L1", os: "all", why: "纯策略函数" },
  { file: "test/log-persistence-test.js", tier: "L2", os: "all", why: "拆分自 core-test：日志落盘与轮转" },
  { file: "test/app-state-persist-failclosed-test.js", tier: "L2", os: "all", why: "拆分自 app-ctor-injection：state/config 持久化 fail-closed" },
  { file: "test/distribution-registry-contract-test.js", tier: "L2", os: "all", why: "原 round13-contract-reload（去轮次前缀）：registry 契约重载" },
  { file: "test/instance-remove-mutex-test.js", tier: "L2", os: "all", why: "拆分自 round13-discipline-gaps：实例删除互斥" },
  { file: "test/token-file-persist-mode-test.js", tier: "L2", os: "all", why: "拆分自 round13-discipline-gaps：令牌落盘 0600" },
  { file: "test/instance-start-port-precheck-test.js", tier: "L2", os: "all", why: "拆分自 round13-discipline-gaps：启动前端口预检（PORT_TAKEN）" },
  { file: "test/remote-mode-wan-gate-test.js", tier: "L2", os: "all", why: "拆分自 round13-router-relay-gaps：远程模式 WAN 闸" },
  { file: "test/relay-token-hotswap-test.js", tier: "L2", os: "all", why: "拆分自 round13-router-relay-gaps：relay 令牌热换" },
  { file: "test/relay-html-inject-budget-test.js", tier: "L2", os: "all", why: "拆分自 round13-router-relay-gaps：HTML 注入预算" },
  { file: "test/router-oauth-callback-rounds-test.js", tier: "L2", os: "all", why: "拆分自 round13-router-relay-gaps：OAuth 回调轮次" },
  { file: "test/external-open-test.js", tier: "L2", os: "all", why: "平台层外部打开（探测/分发依据/计划/执行/证据；四条真机事故回归）" },
  { file: "test/cookie-attributes-test.js", tier: "L2", os: "all", why: "/open 的 SameSite=Strict 与门卫 cookie 的 SameSite=Lax（安全面，原为零覆盖）" },
];

const ALL_OS = ['linux', 'darwin', 'win32'];

/** 不带 -test 后缀但按测试登记的两个文件（不改名，避免大范围改动）。 */
const IN_CHAIN_LEGACY = ['smoke.js', 'ports-verify.js'];

function osSet(entry) {
  return entry.os === 'all' ? ALL_OS.slice() : entry.os.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 链条目（登记表全量，保持登记顺序；按宿主筛由 select 负责）。 */
function chain() {
  return ENTRIES.map((e) => e.file);
}

/** 按 tier / 宿主筛选要跑的条目。tier='all' 取全量且不按宿主过滤：平台不适用的条目
 *   由测试自己打 SKIP（诚实可见），静默不跑会把「没验过」伪装成「通过」。 */
function select(tier, platform) {
  const pl = platform || process.platform;
  if (tier === 'all') return ENTRIES.slice();
  return ENTRIES.filter((e) => e.tier === tier && osSet(e).indexOf(pl) >= 0);
}

/** 本宿主应跑但表里标了别的 OS 的 L2 条目 = 该平台缺口（供 SKIP 台账读）。 */
function gaps(platform) {
  const pl = platform || process.platform;
  if (ALL_OS.indexOf(pl) < 0) return [];
  return ENTRIES.filter((e) => e.tier === 'L2' && osSet(e).indexOf(pl) < 0).map((e) => e.file);
}

module.exports = { ENTRIES, IN_CHAIN_LEGACY, chain, select, gaps, osSet, ALL_OS };
