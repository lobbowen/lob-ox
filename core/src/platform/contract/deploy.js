'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isBinaryExecutable(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      const elf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
      const pe = head[0] === 0x4d && head[1] === 0x5a;
      const macho = (head[0] === 0xcf && head[1] === 0xfa) || (head[0] === 0xca && head[1] === 0xfe);
      return elf || pe || macho;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

function isLauncherForm(target) {
  try {
    const dir = path.dirname(target);
    if (fs.existsSync(path.join(dir, 'core.cjs'))) return true;
    if (fs.existsSync(path.join(dir, '..', 'core.cjs'))) return true;
    return false;
  } catch { return false; }
}

function runningTarget() {
  try {
    const a1 = process.argv[1];
    if (!a1) return null;
    return fs.realpathSync(path.resolve(a1));
  } catch { return null; }
}

function detect() {
  const forced = process.env.DSH_DEPLOY_FORM;
  const target = runningTarget();
  if (forced === 'sea-binary') {
    return { form: 'sea-binary', runningTarget: target, updatable: true, reason: null };
  }
  if (!target) {
    return { form: 'unknown', runningTarget: null, updatable: false, reason: '无法定位当前运行文件' };
  }
  if (isBinaryExecutable(target)) {
    return { form: 'sea-binary', runningTarget: target, updatable: true, reason: null };
  }
  if (isLauncherForm(target)) {
    return { form: 'launcher', runningTarget: target, updatable: true, reason: null };
  }
  return {
    form: 'source-shell',
    runningTarget: target,
    updatable: false,
    reason: '当前为源码开发形态（bin 脚本壳指向源码目录），npm 自更新不适用；请以标准产品形态（npm i -g ' +
      '或桌面壳安装）部署后使用自更新',
  };
}

module.exports = { detect, isLauncherForm, runningTarget };
