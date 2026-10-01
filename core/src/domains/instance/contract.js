'use strict';

module.exports = {
  domain: 'instance',

  exports: ['InstanceManager'],

  PUBLIC_API: [
    'instances',
    'all', 'forEach', 'find', 'map',
    'list', 'load', 'save',
    'addInstance', 'removeInstance', 'updateInstance',
    'startInstance', 'stopInstance', 'supervise', 'probeInstance',
    'governSweep',
    'checkUpdate', 'upgradeInstance', 'upgradeStatus', 'startTimer',
    'budgetSnapshot',
    'launchCtx',
    'sandboxRoot', 'sandboxDataDir', 'sandboxInstallDir', 'sandboxSupported',
    'onRemoteChange', 'onRemove', 'onInstanceStart', 'onInstanceStop', 'onCreate', 'onDestroy',
    'dshBin',
  ],

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
    throttle: '实例域启动失败限流参数 { windowMs, burst }（按域参数化，缺省 10min / 5 次；判定原语与主链同为 shared/guardian.bumpStartupFailure）',
    hooks: {
      onRemoteChange: '实例远程配置变化（compose/observers.js 注入）',
      onRemove: '实例移除（compose/observers.js 注入）',
      onInstanceStart: '实例启动（compose/observers.js 注入）',
      onInstanceStop: '实例停止（compose/observers.js 注入）',
      onCreate: '实例创建（compose/observers.js 注入）',
      onDestroy: '实例销毁（compose/observers.js 注入）',
    },
  },

  hooks: {
    onRemoteChange: true, onRemove: true, onInstanceStart: true,
    onInstanceStop: true, onCreate: true, onDestroy: true,
  },

  pure: [
    'domains/instance/model.js',
    'domains/instance/sandbox.js',
    'domains/instance/state-machine.js',
  ],

  exempt: {
    hooks: '6 个出站回调为 compose 注入（不是域内跨文件 this 调用）',
  },
};
