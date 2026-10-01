'use strict';

// instance 域契约声明：纯数据，零 require、零副作用。
// exports 取 index.js 的 module.exports 字面量键（双向一致）；PUBLIC_API 为全仓消费点；
// pure 为零 IO require 的纯文件；deps.hooks 声明 6 个出站回调。

module.exports = {
  domain: 'instance',

  // 门面对外导出面（== index.js module.exports 字面量键，双向一致）
  exports: ['InstanceManager'],

  // 域间契约（消费方成员必须 <= 本表）
  PUBLIC_API: [
    // instances 活数组（冻结接口：store 唯一持有，getter 每次返回当前数组引用）
    'instances',
    // 查询接口（跨域消费方只经这些方法访问，不直读活数组）
    'all', 'forEach', 'find', 'map',
    // 查询 / 持久化
    'list', 'load', 'save',
    // 注册表增删改
    'addInstance', 'removeInstance', 'updateInstance',
    // 生命周期 + 探活 + 升级 + 定时
    'startInstance', 'stopInstance', 'supervise', 'probeInstance',
    // 治理单拍（heartbeat 拍末一次 decide，消费者 = compose/domains.js 的 onBeatDone）
    'governSweep',
    'checkUpdate', 'upgradeInstance', 'upgradeStatus', 'startTimer',
    // 资源预算总览（/env/status 消费）
    'budgetSnapshot',
    // 实例身份锚（启停同值：端口/run.pid/cmdline，systemd 档忽略、portable 档据此归属）
    'launchCtx',
    // 沙箱布局（纯路径推导 + 平台能力）
    'sandboxRoot', 'sandboxDataDir', 'sandboxInstallDir', 'sandboxSupported',
    // 出站 hooks（app/assembly/compose/observers.js 注入）
    'onRemoteChange', 'onRemove', 'onInstanceStart', 'onInstanceStop', 'onCreate', 'onDestroy',
    // 配置的 DSH 可执行名（api/domains/instances.js 的 commandShapeError 读）
    'dshBin',
  ],

  // 类方法面（文档；与 PUBLIC_API 同源，供端口实现者校验）
  classApi: {
    InstanceManager: [
      'all', 'forEach', 'find', 'map',
      'load', 'save', 'list', 'addInstance', 'removeInstance', 'updateInstance',
      'startInstance', 'stopInstance', 'supervise', 'probeInstance',
      'governSweep',
      'checkUpdate', 'upgradeInstance', 'upgradeStatus', 'startTimer',
      'budgetSnapshot',
      'launchCtx',
      'sandboxRoot', 'sandboxDataDir', 'sandboxInstallDir',
    ],
  },

  // ctor 依赖（deps 须与 opts.* 一致；hooks 为豁免出处）
  deps: {
    dir: '实例根目录（守卫状态目录下的 instances/）',
    logger: '日志器',
    events: '事件账本（可空）',
    dist: '统一分发（沙箱 npm 安装与 DSH 自升级共用镜像源）',
    dshBin: 'DSH 可执行名',
    service: '平台服务控制器（平台抽象，禁直接 systemctl；provider 分档：systemd=内核强制 / portable=采样软档，动词三态契约同源）',
    tokenService: '令牌服务（只登记源，不持有/不转发令牌）',
    tasks: '统一安装/更新任务注册表',
    systemdDir: 'systemd user 单元目录',
    systemdTemplatePath: 'systemd 模板单元路径',
    resstats: '进程树资源采样（platform/os/resstats；行为测试注入缝，缺省用真实现）',
    machineFacts: '机器事实供给函数（缺省 governor.machineFacts 读 os；测试注入定死预算）',
    hooks: {
      onRemoteChange: '实例远程配置变化（compose/observers.js 注入）',
      onRemove: '实例移除（compose/observers.js 注入）',
      onInstanceStart: '实例启动（compose/observers.js 注入）',
      onInstanceStop: '实例停止（compose/observers.js 注入）',
      onCreate: '实例创建（compose/observers.js 注入）',
      onDestroy: '实例销毁（compose/observers.js 注入）',
    },
  },

  // 出站 hooks 别名（与 deps.hooks 同源）
  hooks: {
    onRemoteChange: true, onRemove: true, onInstanceStart: true,
    onInstanceStop: true, onCreate: true, onDestroy: true,
  },

  // 纯文件（判据以 src 相对全路径查表）
  pure: [
    'domains/instance/model.js',        // 记录形状/迁移/视图行（唯一 require shared/version）
    'domains/instance/sandbox.js',      // 沙箱路径/命令/systemd 属性纯推导
    'domains/instance/state-machine.js', // 相位转移 + 退避决策（副作用经 deps 显式入参）
  ],

  // 合法例外登记（实际豁免表为 CONTRACT_HOOKS）
  exempt: {
    hooks: '6 个出站回调为 compose 注入（不是域内跨文件 this 调用）',
  },
};
