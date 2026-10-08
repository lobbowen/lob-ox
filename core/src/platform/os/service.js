'use strict';

const { portable } = require('./portable');
const OUTCOME = require('../../shared/outcome');

class CapabilityError extends Error {
  constructor(msg) { super(msg); this.name = 'CapabilityError'; this.code = 'CAPABILITY_UNSUPPORTED'; }
}

const PLATFORM = process.platform;

const UNSUPPORTED_KIND = 'none';

// 与 portable 的**方法集逐项对齐**（platform-layer-portability-test.js X-3 对此静态对账）：
// 不支持则如实抛 CapabilityError（绝不静默返回成功），查询类返回 unknown/null。
function unsupported() {
  const fail = (m) => () => { throw new CapabilityError('无服务管理器：' + m); };
  return {
    kind: UNSUPPORTED_KIND,
    supportsUnits: false,
    supportsTransient: false,

    // 能力协商：与 portable 同类，未知平台一律不支持（保持方法集一致）。
    supports() { return false; },

    daemonReload: fail('daemonReload'),
    resetFailed: fail('resetFailed'),

    startTransient: fail('startTransient'),
    stopUnit: fail('stopUnit'),
    isUnitActive: () => OUTCOME.UNKNOWN,
    transientUnitFile: () => null,
    cleanTransient: fail('cleanTransient'),
    setLimits: () => false,
  };
}

const NONE = unsupported();

/// 服务控制器分派（**唯一权威：仓库根 STANDARDS.md「服务管理器 = 产品自身的监控器」**）。
///
/// 服务管理器是 lob-ox **自己建立**的机制，与操作系统没有任何关系：
///   - 不是 systemd / launchd / 任务计划程序的封装或借用；
///   - **不存在「用系统通道投递服务」这个选项**。
/// 故 Linux 上即使探测到 `systemd-run`，也**一律走 portable**（产品自身 detached spawn +
/// pid 文件 + 端口/命令行锚点判活）。
///
/// 代价（如实声明）：portable 的 `setLimits` 返回 false ⇒ 不再有 cgroup 级的
/// 内存/CPU 上限强制。资源约束改由产品自身的监控与限流承担，
/// 不以「借 OS 通道」换回这一能力。
function current() {
  if (PLATFORM === 'linux' || PLATFORM === 'darwin' || PLATFORM === 'win32') return portable;
  return NONE;
}

module.exports = {
  current,
  CapabilityError,
  kind: () => current().kind,
  PLATFORM,
  _testProviders: { portable, NONE },
};
