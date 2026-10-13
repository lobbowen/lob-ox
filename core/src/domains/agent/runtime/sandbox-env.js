'use strict';

// agent 沙箱化的 env 隔离（数据隔离，非安全隔离）。
//
// 从 domains/instance/sandbox.js 的 sandboxEnv 收拢而来——那原本只服务「沙箱实例」，
// 但 env 重定向这件事本身与 instance 无关，是 agent 形态（sandbox）的运行时属性。
//
// 铁律：**覆盖 agent 实际会写的全部用户级位置**。漏一个，
// 「各自独立数据目录」就在那个位置上失效（多个 agent 写进同一真实目录）。
// Windows 上 os.homedir() 读 USERPROFILE 而非 HOME，故 HOME 重定向在 Windows 上
// 单独设置是不生效的——必须同时设 USERPROFILE。

const path = require('node:path');
const { isWindows } = require('../../../shared/platform');


function sandboxEnv(dirs) {
  // 入参校验：缺 data 就没有隔离目标，静默返回空 env 会让调用方以为隔离生效。
  if (!dirs || !dirs.data) return { env: {}, workingDir: null };
  const data = dirs.data;
  const install = dirs.install || data;
  const env = {};
  const nodeBinDir = path.dirname(process.execPath);
  const paths = [nodeBinDir, path.join(install, 'bin'), process.env.PATH || ''].join(path.delimiter);
  env.HOME = data;
  env.USERPROFILE = data;              // Windows：os.homedir() 优先读它
  env.XDG_CONFIG_HOME = data;
  env.XDG_DATA_HOME = data;
  env.XDG_CACHE_HOME = path.join(data, 'cache');
  env.XDG_STATE_HOME = path.join(data, 'state');
  if (isWindows) {
    env.APPDATA = path.join(data, 'Roaming');
    env.LOCALAPPDATA = path.join(data, 'Local');
  }
  env.PATH = paths;
  env.NODE_PATH = dirs.nodeModules;
  env.npm_config_cache = path.join(data, 'npm-cache');
  env.npm_config_userconfig = path.join(data, '.npmrc');
  env.npm_config_globalconfig = path.join(data, '.npmrc');
  env.TMPDIR = dirs.tmp || path.join(data, 'tmp');
  if (isWindows) { env.TMP = env.TMPDIR; env.TEMP = env.TMPDIR; }
  return { env, workingDir: data };
}


module.exports = { sandboxEnv };
