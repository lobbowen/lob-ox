'use strict';

// api/deps —— 每域所需的 supervisor 成员显式声明（只声明，不强制）。无运行期校验：过渡期门面方法可能被移动/改名而声明表未同步，
// 缺成员即报错会误报为运行时故障。改 supervisor / 删 sup 方法前先查本表；`config` 语义为 sup.config（apiPort/apiAccessKey 等）。
// 口径：只列该域 handle(ctx) 直接消费的成员（经 ctx 转交的不计）；网关自身消费的成员单列 GATEWAY；新增域/新增 sup 读取点必须同步本表，否则本表失效。

/** 网关自身（api/index.js）直接消费的 sup 成员（域分派之前/之后）。 */
const GATEWAY = {
  // 访问密钥门卫读 sup.config.apiAccessKey；令牌下发经 sup.tokenService。
  sup: ['config', 'tokenService'],
};

/** 每域 handle(ctx) 直接读取的 sup 成员（按 domains/ 下模块归集）。 */
const DOMAIN_DEPS = {
  // 统一安装/更新任务（Task Registry）。
  tasks: ['tasks'],

  // 统一生命周期：status/lifecycle/healthz/readyz/events/logs/metrics/session。
  lifecycle: [
    'config',            // originAllowed 需要 apiPort（写动作 CSRF 闸）
    'desired', 'phase',  // /lifecycle/dsh/{start|stop|restart} 回执形状
    'eventHub',          // /events、/logs/tail、/logs/export、/metrics 的统一读路径
    'events',            // eventHub 缺失时的空事件兜底（seq）
    'health',            // /healthz、/readyz（缺失时回退默认）
    'lifecycleManager',  // 模块生命周期唯一入口
    'sessionState',      // /session/status（INV-S4 唯一读取口）
    'shutdownAll',       // /session/stop（INV-S2 退出唯一入口）
    'statusSummary',     // /status、dsh 启停回执
  ],

  // 原生 DSH 生命周期（唯一通道）。
  native: [
    'config',         // 写动作 CSRF 闸
    'nativeManager',  // status/versionInfo/upgradeStatus/install/upgrade/uninstall
    'patchDshMain',   // /native/settings：main 元数据补丁（guardian）——实现：app/domain-actions/main.js
  ],

  // 守卫/设置域：changelog / 版本 / autostart / settings / self-update / env / ports / shutdown。
  guard: [
    'config',
    'nativeManager',         // /changelog：DSH 版本信息
    'guardVersionLocal', 'guardVersionCheck',
    'autostartStatus', 'setAutostart',
    'lanPanelStatus', 'setLanPanel',
    'accessKeyStatus', 'setAccessKey',
    'closeActionStatus', 'setCloseAction',
    'externalBrowserStatus', 'setExternalBrowser', // /settings/external-browser：外部打开的浏览器偏好（实现：app/settings/browser.js）
    'shutdownAll',           // /shutdown（旧退出入口）
    'guardSelfUpdateStatus', // /self-update/status（只读；写端点已下架=410）
    'dshenvStatus', 'envStatus', 'nodeLtsStatus',
    'listPorts',             // /ports 统一端口清单
  ],

  // 智能路由（中转服务）：状态/生命周期/供应商/反代/账号。
  router: [
    'config',
    'routerApi',            // ctl 门面（portsView/providers/keys/login/update/...）——实现：app/facade/router.js
    'routerDomainSummary',  // daemon 监督拍的域摘要缓存
    'routerProviders', 'routerStatusView',
    'setRouterRunning',     // /router/{start|stop}——实现：app/domain-actions/router.js
  ],

  // 插件管理。
  plugins: ['config', 'pluginManager', 'pluginMarket'],

  // 镜像源分发（/dist/registry*，DistributionManager 统一管理）。
  dist: ['config', 'dist'],

  // 沙箱实例 CRUD/启停/open-web/版本更新（+ 原生 main 只读视图）。
  instances: [
    'config',
    'instances',    // 沙箱实例管理对象（list/addInstance/startInstance/...）
    'dshMainView',  // 原生主干 main 的守卫核心视图（只读条目）
  ],

  // 远程控制/中继（lan-access / remote）。
  // 读写分层：只读 frpStatus/listLan 在 app/facade/lan.js；
  //   写动作 setRemoteMode/setRemoteToken/lanFrpc 在 app/domain-actions/lan.js（本地经 lifecycle 'lan' 登记项唯一入口）。
  relay: ['config', 'frpStatus', 'listLan', 'setRemoteMode', 'setRemoteToken', 'lanFrpc'],

  // 桌面壳更新安全网（/shell/*）——内核仅做安全网，非更新源。
  shell: [
    'config',
    'shellDomain',  // 壳安全网（status/health/markPending/checkUpdate/restartShell）
    'dist',         // checkUpdate 复用分发服务查版本
    'events',       // 更新账本事件追加
  ],
};

module.exports = { GATEWAY, DOMAIN_DEPS };
