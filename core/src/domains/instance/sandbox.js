'use strict';

const platform = require('../../platform/os/index');
// `dsh web` 不得自弹浏览器：这条 CLI 契约的唯一实现，主实例命令组装口取的是同一份。
const dshCli = require('../../platform/contract/dsh-cli');

// 沙箱布局：目录推导、启动命令、systemd 属性与 env 装配、平台能力判决。
// 纯函数，rootDir 由组装根绑定后显式传入（无状态、无隐式 this）；能力判决只查 platform/os 的缓存能力矩阵（负结果 60s TTL），不直接 spawn。
const path = require('node:path');
function root(rootDir, inst) { return path.join(rootDir, inst.id); }
/** 该实例独立数据目录：作为实例运行的 HOME/XDG_CONFIG_HOME（内置独立 .dsh 等）。 */
function dataDir(rootDir, inst) { return path.join(root(rootDir, inst), 'data'); }
/** 该实例独立依赖目录：完整 DSH 安装处，node_modules 与原生隔离。 */
function installDir(rootDir, inst) { return path.join(root(rootDir, inst), 'install'); }
/** npm -g --prefix 布局分平台：POSIX=<prefix>/lib/node_modules，win32=<prefix>/node_modules；
 *  硬编码 POSIX 形在 Windows 必失配。 */
function nodeModulesDir(rootDir, inst) {
  const install = installDir(rootDir, inst);
  return platform.isWindows ? path.join(install, 'node_modules') : path.join(install, 'lib', 'node_modules');
}
/** 沙箱内 DSH 入口：node 直启 lib/bin.js，不经 win32 的 .cmd 垫片。 */
function dshEntry(rootDir, inst) {
  return path.join(nodeModulesDir(rootDir, inst), '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}
/** TMPDIR 是 PrivateTmp 的三平台一致泛化（win/mac 无命名空间可借）。 */
function tmpDir(rootDir, inst) { return path.join(root(rootDir, inst), 'tmp'); }
/** portable 档 run.pid：仅「STARTING 未监听窗口」的停止兜底；systemd 档不读它。 */
function runPidFile(rootDir, inst) { return path.join(root(rootDir, inst), 'run.pid'); }
/** 启停共用身份上下文（portable provider 的归属锚；systemd provider 忽略附加字段）。
 *  anchors = 入口文件路径 + --port 参数：由 effectiveCommand 确定性推导、启停两侧同值，
 *  命中才认定「我们的进程」——防 PID 复用误杀与端口被他人占用时的错误连坐。 */
function launchCtx(rootDir, dshBin, inst) {
  const cmd = effectiveCommand(rootDir, dshBin, inst) || [];
  const anchors = [];
  if (cmd[1]) anchors.push(String(cmd[1]));
  if (inst.port) anchors.push('--port ' + inst.port);
  return { port: inst.port, pidFile: runPidFile(rootDir, inst), anchors };
}

/** 沙箱默认启动命令：执行「官方 npm install -g --prefix」装进该沙箱 install 目录的 DSH。 */
function sandboxCommand(rootDir, inst) {
  const bin = dshEntry(rootDir, inst);
  return [process.execPath, bin, 'web', '--port', String(inst.port), '--host', '127.0.0.1', '--trusted-host', '127.0.0.1', '--no-open'];
}
function defaultCommand(dshBin, inst) {
  return [process.execPath, dshBin, 'web', '--port', String(inst.port), '--host', '127.0.0.1', '--trusted-host', '127.0.0.1', '--no-open'];
}
/** 有效启动命令优先级：用户显式 command > 沙箱独立安装默认命令 > 宿主 dshBin 默认命令。
 *  三条都过 withoutAutoOpen —— 优先级说的是「用哪条命令」，不改变「web 启动不得自弹浏览器」。 */
function effectiveCommand(rootDir, dshBin, inst) {
  if (inst.domain === 'sandbox' && (!inst.command || !inst.command.length)) return dshCli.withoutAutoOpen(sandboxCommand(rootDir, inst));
  if (inst.command && inst.command.length) return dshCli.withoutAutoOpen(inst.command);
  return dshCli.withoutAutoOpen(defaultCommand(dshBin, inst));
}
/** systemd transient 单元属性（业务约束以「属性」表达，域层不拼 systemd 参数；平台只翻译语义、不决定数额）。
 *  alloc 的 MemoryMax/MemoryHigh/CPUQuota 由 governor 按机器预算与活跃实例数推导——用户填额已废止，
 *  静态数字既会超卖也闲置；MemoryHigh 是真内核节流软顶（回收先于 OOM），仅在推导出时下发。 */
function unitProps(inst, alloc) {
  const props = [
    'KillMode=process',
    'MemoryMax=' + alloc.memoryMax,
  ];
  if (alloc.memoryHigh) props.push('MemoryHigh=' + alloc.memoryHigh);
  props.push(
    'CPUQuota=' + alloc.cpuQuota,
    'PrivateTmp=' + ((inst.sandbox && inst.sandbox.privateTmp) ? 'yes' : 'no'),
    'ProtectHome=' + ((inst.sandbox && inst.sandbox.protectHome) ? 'yes' : 'no'),
    'Restart=no',
  );
  return props;
}

/** 沙箱实例的环境与工作目录装配（native 无 env）。 */
function sandboxEnv(rootDir, inst) {
  const env = {};
  let workingDir = null;
  if (inst.domain === 'sandbox') {
    const data = dataDir(rootDir, inst);
    const install = installDir(rootDir, inst);
    const nodeBinDir = path.dirname(process.execPath);
    const paths = [nodeBinDir, path.join(install, 'bin'), process.env.PATH || ''].join(path.delimiter);
    env.HOME = data;
    env.XDG_CONFIG_HOME = data;
    env.XDG_DATA_HOME = data;
    env.PATH = paths;
    env.NODE_PATH = nodeModulesDir(rootDir, inst);
    // 临时目录隔离三平台一致：POSIX 用 TMPDIR，win32 只认 TMP/TEMP（PrivateTmp 是 Linux 独有加法）。
    env.TMPDIR = tmpDir(rootDir, inst);
    if (platform.isWindows) { env.TMP = env.TMPDIR; env.TEMP = env.TMPDIR; }
    workingDir = data;
  }
  return { env, workingDir };
}

/** 平台能力判决（实时求值）：判据 = capabilities.sandboxLaunch（三平台恒真：Linux 有 systemd-run 走 cgroup 硬档，
 *  其余落 portable provider；执行档位另看 sandboxEnforcement）。
 *  override 非空则显式覆写（仅供测试/嵌入方）；否则实时问 platform/os capabilities()，其负结果有 60s TTL，不会每次 spawn 探测。 */
function supported(override) {
  if (override !== undefined && override !== null) return override === true;
  try {
    const caps = platform.capabilities();
    return !!(caps && caps.sandboxLaunch === true);
  } catch { return false; }
}

module.exports = {
  root, dataDir, installDir, nodeModulesDir, dshEntry, tmpDir, runPidFile, launchCtx,
  effectiveCommand, unitProps, sandboxEnv, supported,
};
