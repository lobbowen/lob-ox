'use strict';

// 插件域纯策略/判定（零 IO）：参数安全校验、spec/版本/补丁行归属判定、
// 包名归属推断、目标补丁路径推导、CLI argv 组装，全部为具名纯函数。

const { semverCompare } = require('../../shared/version');
// 纯谓词的单源在 model.js，此处再导出以维持既有导入面。
const { isProtectedName, isOwnRow, isOwnDisabled, ownerPackage, targetHomePatchPath } = require('./model');

/** 禁止以 - 开头的非法插件参数（top-40 截断用于文案）。 */
function assertSafeCliArgs(args) {
  for (const a of args) {
    if (typeof a === 'string' && a.length > 1 && a[0] === '-' && !/^-[0-9]/.test(a)) {
      return '非法插件参数（禁止以 - 开头）: ' + a.slice(0, 40);
    }
  }
  return null;
}

/** 从模块说明符推断插件类型：npm（默认）/ git / local。 */
function specType(spec) {
  const sp = String(spec || '');
  if (sp.startsWith('git+') || sp.startsWith('github:') || sp.endsWith('.git')) return 'git';
  if (sp.startsWith('file:') || sp.startsWith('link:') || sp.startsWith('.') || sp.startsWith('/')) return 'local';
  return 'npm';
}

function isUpdateAvailable(latest, version) {
  return !!latest && !!version && semverCompare(String(latest), String(version)) > 0;
}

/** dsh plugin CLI 参数前缀（plugin --profile <name> [--store-dir <dir>]）。 */
function cliArgv(target) {
  const cliArgs = ['plugin', '--profile', target.profileName];
  if (target.storeDir) cliArgs.push('--store-dir', target.storeDir);
  return cliArgs;
}

module.exports = {
  isProtectedName, assertSafeCliArgs, specType, isUpdateAvailable,
  isOwnRow, isOwnDisabled, ownerPackage, targetHomePatchPath, cliArgv,
};
