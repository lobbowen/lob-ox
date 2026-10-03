'use strict';

const CATEGORIES = ['public', 'operational', 'internal', 'deprecated'];

const SURFACE = [
  { path: '/status',         methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['UI(polling)', 'CLI(status)'], note: '状态摘要' },
  { path: '/events',         methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['UI(timeline)'], note: '增量事件' },
  { path: '/healthz',        methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['壳(握手探针)'], note: '存活探针' },
  { path: '/readyz',         methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['监控/编排探针'], note: '就绪探针（守卫已初始化且未停机）' },
  { path: '/session/status', methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['壳(get_session_state)'], note: '会话态读取口' },
  { path: '/session/stop',   methods: ['POST'], domain: 'lifecycle', category: 'public',      consumers: ['壳(退出握手)'], note: '停全部被管对象 + 回执（守卫不自停）' },
  { path: '/metrics',        methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['监控接入'], note: '监控：事件流派生遥测（bySource/topTypes/事件率）' },
  { path: '/logs/tail',      methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['远程诊断'], note: '诊断：各 stream 日志尾部（跨机排障；本机 CLI 直读文件）' },
  { path: '/logs/export',    methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['审计/离线备份'], note: '审计：聚合流 JSONL 导出（离线备份/合规留痕）' },
  { path: '/lifecycle',      methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['UI'], note: '模块生命周期一览（=/lifecycle/status）' },
  { path: '/lifecycle/status', methods: ['GET'], domain: 'lifecycle', category: 'public',     consumers: ['UI'], note: '同上（显式别名）' },

  { path: '/changelog',            methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(AboutCard)'], note: 'DSH 更新日志（text/plain）' },
  { path: '/guard/changelog',      methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(AboutCard)'], note: '管家更新日志（CHANGELOG.md）' },
  { path: '/guard/version',        methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(AboutCard)'], note: '本地版本（无网络 I/O）' },
  { path: '/guard/version/check',  methods: ['POST'], domain: 'guard', category: 'public',      consumers: ['UI(AboutCard, 源码形态)'], note: 'git 上游检查（源码部署形态更新通道）' },
  { path: '/autostart',            methods: ['GET', 'POST'], domain: 'guard', category: 'public', consumers: ['UI(StartupCard)'], note: '整条服务链开机自启' },
  { path: '/shutdown',             methods: ['POST'], domain: 'guard', category: 'deprecated',  consumers: ['旧版壳兼容'], note: '替代 = POST /session/stop；保留供旧壳退出（移除条件：壳最低版本 >= 使用 /session/stop 的版本）' },
  { path: '/ports',                methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(PortPanel)'], note: '端口视图（聚合三注册表）' },
  { path: '/env/dsh',              methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['README 文档化（外部脚本）'], note: 'DSH 本体安装/纳管判定（bin/binOk/managed/phase）' },
  { path: '/env/status',           methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(InstancesPage 能力矩阵)'], note: '环境 + 平台能力矩阵 + catalog' },
  { path: '/env/node-lts',         methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(OverviewPage)'], note: 'Node 当前 vs 官方最新 LTS' },
  { path: '/env/open-url',         methods: ['POST'], domain: 'guard', category: 'public',      consumers: ['UI(externalOpen 地址行)'], note: '请内核用系统默认浏览器打开 http(s) 地址（三档结果原样回传，失败带 evidence.diagnostics 探测留痕；仅回环来源，壳内 webview 丢弃 window.open 时代的唯一代开方）' },
  { path: '/env/environment',      methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(OverviewPage 环境表单)', 'README 文档化（人工/支持排障直读；打开动作的诊断走 evidence.diagnostics）'], note: '环境表单（只读装配面，schema 2 维度台账）：候选浏览器 + 系统默认及其来源 + 图形会话 + 能力档位 + 用户偏好 + 这一拍的分发依据 + 运行时（Node/npm/镜像源/全局前缀）+ 出网条件（系统代理与目标域通路）+ 每条系统查询留痕；?force=1 异步补齐各维度并落快照' },
  { path: '/env/environment/last', methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(OverviewPage 环境表单的上一拍留痕)', 'README 文档化（人工/支持排障直读）'], note: '上一拍环境快照的只读回看口（零摸网零写盘，绝不参与分发判定）：available/at/ageMs/path + 整份上一拍表单；没写过（never-written）与读不出（unreadable-or-schema-mismatch）分开标' },
  { path: '/settings/external-browser', methods: ['GET', 'POST'], domain: 'guard', category: 'public', consumers: ['UI(OverviewPage 环境表单)'], note: '外部打开的浏览器偏好（id 必须是本机候选；空串清除）' },
  { path: '/settings/access-key',  methods: ['GET', 'POST'], domain: 'guard', category: 'public', consumers: ['UI(StartupCard)'], note: '访问密钥' },
  { path: '/settings/close-action', methods: ['GET', 'POST'], domain: 'guard', category: 'public', consumers: ['UI(StartupCard)', '壳(读取执行)'], note: '关窗行为（hide/exit）' },
  { path: '/settings/lan',         methods: ['GET', 'POST'], domain: 'guard', category: 'public', consumers: ['UI(StartupCard)'], note: '面板局域网访问开关' },
  { path: '/self-update/status',   methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(AboutCard)'], note: '内核更新状态（只读；安装归桌面壳）' },
  { path: '/self-update/apply',    methods: ['POST'], domain: 'guard', category: 'deprecated',  consumers: ['无'], note: '单写入者=壳：返回 410 KERNEL_UPDATE_SINGLE_WRITER；替代 = 桌面壳 kernel_update_apply' },
  { path: '/self-update/restart-guard', methods: ['POST'], domain: 'guard', category: 'deprecated', consumers: ['无'], note: '守卫不自重启：返回 410；替代 = 壳在安装后经服务管理器重启守卫' },

  { path: '/native/status',       methods: ['GET'],  domain: 'native', category: 'public', consumers: ['UI(OverviewPage)', 'CLI(status)'], note: '安装状态 + 版本 + 升级状态机' },
  { path: '/native/check-update', methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)'], note: '触发版本检查' },
  { path: '/native/install',      methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)', 'CLI'], note: '异步安装（202）' },
  { path: '/native/uninstall',    methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)'], note: '异步卸载（202）' },
  { path: '/native/upgrade',      methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)', 'CLI(upgrade)'], note: '一键升级（失败回滚）' },
  { path: '/native/settings',     methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)'], note: 'main 元数据补丁（仅 guardian；远程意图唯一入口在 /remote/*）' },

  { path: '/instances',           methods: ['GET'],  domain: 'instances', category: 'public', consumers: ['UI(InstancesPage)'], note: '实例列表（+ POST /instances/{action}）；远程访问令牌明文仅回环来源下发（其余只见 tokenSet 布尔），authUrl 的 ?token= 同判据' },
  { path: '/open',                methods: ['GET'],  domain: 'instances', category: 'public', consumers: ['UI(open-web → 本机系统浏览器一次性码跳转)'], note: '一次性码换取 dsh-auth cookie 并回跳实例 DSH 页面（令牌不进 URL/argv）' },

  { path: '/plugins/market',         methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage)'], note: '市场索引（TTL 缓存）' },
  { path: '/plugins/installed',      methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage)'], note: '已装第三方插件' },
  { path: '/plugins/check-updates',  methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage)'], note: '已装插件更新检测' },
  { path: '/plugins/install-status', methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage, job 轮询)'], note: '插件任务进度' },

  { path: '/router/status',          methods: ['GET'],  domain: 'router', category: 'public',   consumers: ['UI(RouterPage)'], note: '中转状态 + 用量' },
  { path: '/router/providers',       methods: ['GET'],  domain: 'router', category: 'public',   consumers: ['UI(RouterPage)'], note: '供应商 + 账号 + 实例视图' },
  { path: '/router/ports',           methods: ['GET'],  domain: 'router', category: 'internal', consumers: ['p2p-api 契约测试（域分离验证）'], note: 'router 自治段端口视图（daemon 模式物理分离）' },
  { path: '/router/domain-summary',  methods: ['GET'],  domain: 'router', category: 'internal', consumers: ['守卫监督拍自消费（写目录 domainSummary）'], note: '域摘要只读缓存' },
  { path: '/router/providers/account/discard', methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '账号丢弃' },
  { path: '/router/providers/activate',   methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '激活供应商' },
  { path: '/router/providers/add',        methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '新增供应商' },
  { path: '/router/providers/deactivate', methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '停用供应商' },
  { path: '/router/providers/key/use',    methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '切换使用中的 Key' },
  { path: '/router/providers/keys/set',   methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '设置供应商 Key' },
  { path: '/router/providers/proxy/key',        methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '反代 Key 写入' },
  { path: '/router/providers/proxy/key/remove', methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '反代 Key 移除' },
  { path: '/router/providers/proxy/select',     methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '选择反代' },
  { path: '/router/providers/refresh',    methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '刷新供应商' },
  { path: '/router/providers/remove',     methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '删除供应商' },
  { path: '/router/proxy/login/start',    methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: 'Command Code 一键登录（发起）' },
  { path: '/router/proxy/login/wait',     methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '登录等待' },
  { path: '/router/proxy/update/apply',   methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '反代更新（job）' },
  { path: '/router/proxy/update/check',   methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '反代版本检测' },
  { path: '/router/proxy/update/status',  methods: ['GET'],  domain: 'router', category: 'public', consumers: ['UI(RouterPage, job 轮询)'], note: '反代更新进度' },

  { path: '/dist/registry',         methods: ['GET'],  domain: 'dist', category: 'public', consumers: ['UI(RegistryCard)'], note: '镜像源状态' },
  { path: '/dist/registry/refresh', methods: ['POST'], domain: 'dist', category: 'public', consumers: ['UI(RegistryCard)'], note: '镜像源测速刷新' },
  { path: '/dist/registry/set',     methods: ['POST'], domain: 'dist', category: 'public', consumers: ['UI(RegistryCard)'], note: '镜像源手动固定' },
  { path: '/dist/registry/probe',   methods: ['POST'], domain: 'dist', category: 'public', consumers: ['UI(RegistryCard 测试按钮)'], note: '同源单源探活（服务端，不受页面 CSP 限制）' },

  { path: '/lan-access',       methods: ['GET'],  domain: 'relay', category: 'public', consumers: ['UI(LanPage)'], note: '远程代理列表（脱敏：任何令牌字段都不外传；remote 视图为访问 URL/就绪判定的单一来源）' },
  { path: '/remote/frp',       methods: ['GET'],  domain: 'relay', category: 'public', consumers: ['UI(LanPage)'], note: 'frpc 状态（设置 + 运行态 + wan 暴露清单）' },

  { path: '/tasks', methods: ['GET'], domain: 'tasks', category: 'public', consumers: ['UI(TasksPage)'], note: '统一任务列表（+ /tasks/{id}）' },

  { path: '/shell/status',         methods: ['GET'],  domain: 'shell', category: 'public',      consumers: ['UI(壳状态卡)', 'CLI'], note: '壳身份 + 更新账本 + 判定结论' },
  { path: '/shell/health',         methods: ['POST'], domain: 'shell', category: 'operational', consumers: ['运维：排障时手工上报壳阶段（壳未接线，实测零调用）'], note: '诊断用途：phase=ready 即更新确认信号，供排障手工驱动安全网；当前 evaluate() 因缺输入恒 idle' },
  { path: '/shell/update-pending', methods: ['POST'], domain: 'shell', category: 'operational', consumers: ['运维：排障时手工建立更新账本（壳未接线，实测零调用）'], note: '诊断用途：建立更新账本（待重启确认），供排障手工驱动内核侧安全网' },
  { path: '/shell/check-update',   methods: ['POST'], domain: 'shell', category: 'public',      consumers: ['UI(关于卡)'], note: '壳版本检测（与内核自更新同源：npm registry + 镜像回退）' },
  { path: '/shell/restart',        methods: ['POST'], domain: 'shell', category: 'public',      consumers: ['UI(关于卡)'], note: '重启桌面壳以应用更新（壳门 0 在新进程内完成安装）' },

];

const PREFIXES = [
  { prefix: '/dist/',        domain: 'dist',      category: 'public',      consumers: ['UI'], note: '/dist/registry/{refresh|set}' },
  { prefix: '/guard/',       domain: 'guard',     category: 'public',      consumers: ['UI'], note: '/guard/version|changelog 等' },
  { prefix: '/instances/',   domain: 'instances', category: 'public',      consumers: ['UI'], note: '/instances/{add|remove|update|start|stop|check-update|open-web|upgrade}；open-web 回 platform.browser.openBrowser 的三档结果 {ok,confirmed,handedOff,reason,error,url,evidence}，url 恒在场供面板复制/手动打开' },
  { prefix: '/lifecycle',    domain: 'lifecycle', category: 'public',      consumers: ['UI', 'CLI'], note: '/lifecycle/{id}[/{action}]（唯一启停入口）' },
  { prefix: '/lifecycle/',   domain: 'lifecycle', category: 'public',      consumers: ['UI', 'CLI'], note: '同上（显式前缀）' },
  { prefix: '/logs',         domain: 'lifecycle', category: 'operational', consumers: ['诊断/审计'], note: '/logs/{tail|export}（无 events-tail：与 /events 语义重复）' },
  { prefix: '/native/',      domain: 'native',    category: 'public',      consumers: ['UI', 'CLI'], note: '/native/{status|install|uninstall|upgrade|...}' },
  { prefix: '/plugins/',     domain: 'plugins',   category: 'public',      consumers: ['UI'], note: '/plugins/{install|enable|disable|uninstall|update}' },
  { prefix: '/remote/',      domain: 'relay',     category: 'public',      consumers: ['UI'], note: '/remote/{set-mode|set-token|frp-server|frp-install}（意图唯一入口；set-mode 开启时无令牌即自动分配并回执 tokenAutoAllocated，wan 前置闸=访问令牌 ≥8 位；set-token 空串=显式清除）' },
  { prefix: '/router/',      domain: 'router',    category: 'public',      consumers: ['UI'], note: '/router/... （ports/domain-summary 为 internal，见 SURFACE）' },
  { prefix: '/shell/',       domain: 'shell',     category: 'public',      consumers: ['壳', 'UI'], note: '/shell/{status|health|update-pending|check-update|restart}（壳更新强制，无回退）；⚠ health/update-pending 实为壳零调用的排障入口，见上方条目' },
  { prefix: '/self-update/', domain: 'guard',     category: 'public',      consumers: ['UI'], note: '/self-update/status（只读）；apply|restart-guard 返回 410' },
  { prefix: '/settings/',    domain: 'guard',     category: 'public',      consumers: ['UI'], note: '/settings/{lan|access-key|close-action}' },
  { prefix: '/tasks/',       domain: 'tasks',     category: 'public',      consumers: ['UI'], note: '/tasks/{id}' },
];

// W5：summary() 零消费者已删。SURFACE 仍被 shell-safety-net-test.js 断言；
// PREFIXES / CATEGORIES 是 SURFACE 的分类词表，随 SURFACE 一同导出（供契约读者核对分类）。
module.exports = { SURFACE, PREFIXES, CATEGORIES };
