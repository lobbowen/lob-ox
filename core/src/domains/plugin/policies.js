'use strict';

const { semverCompare } = require('../../shared/version');
const { isProtectedName, isOwnRow, isOwnDisabled, ownerPackage, targetHomePatchPath } = require('./model');

function assertSafeCliArgs(args) {
  for (const a of args) {
    if (typeof a === 'string' && a.length > 1 && a[0] === '-' && !/^-[0-9]/.test(a)) {
      return '非法插件参数（禁止以 - 开头）: ' + a.slice(0, 40);
    }
  }
  return null;
}

function specType(spec) {
  const sp = String(spec || '');
  if (sp.startsWith('git+') || sp.startsWith('github:') || sp.endsWith('.git')) return 'git';
  if (sp.startsWith('file:') || sp.startsWith('link:') || sp.startsWith('.') || sp.startsWith('/')) return 'local';
  return 'npm';
}

function isUpdateAvailable(latest, version) {
  return !!latest && !!version && semverCompare(String(latest), String(version)) > 0;
}

function cliArgv(target) {
  const cliArgs = ['plugin', '--profile', target.profileName];
  if (target.storeDir) cliArgs.push('--store-dir', target.storeDir);
  return cliArgs;
}

module.exports = {
  isProtectedName, assertSafeCliArgs, specType, isUpdateAvailable,
  isOwnRow, isOwnDisabled, ownerPackage, targetHomePatchPath, cliArgv,
};
