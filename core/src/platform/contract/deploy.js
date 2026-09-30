'use strict';

// 部署形态判定：自更新的安装目标必须等于运行目标。本模块是形态与运行目标的唯一判定点，
// 调用方（apply/restart/面板显隐）不得自行猜测。
// 标准产品形态不再是 SEA，而是 npm 安装的文本 launcher 加同级 core.cjs（源码开发形态无法自更新）。

const fs = require('node:fs');
const path = require('node:path');

/** SEA 单文件二进制识别：文件头为 ELF/PE/Mach-O magic（node 文本脚本不会以这些字节开头）。 */
function isBinaryExecutable(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      const elf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46; // ELF
      const pe = head[0] === 0x4d && head[1] === 0x5a; // MZ（PE/DOS stub）
      const macho = (head[0] === 0xcf && head[1] === 0xfa) || (head[0] === 0xca && head[1] === 0xfe);
      return elf || pe || macho;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/** launcher 形态识别：运行目标的同目录或上级目录存在 core.cjs 即为发布布局。
 *  两处都查以兼容 argv[1] 指向 bin/dsh-supervisor 或 core.cjs 本身。
 *  不用文本内容是否含 require('../core.cjs') 判定：那与实现细节耦合。 */
function isLauncherForm(target) {
  try {
    const dir = path.dirname(target);
    if (fs.existsSync(path.join(dir, 'core.cjs'))) return true;
    if (fs.existsSync(path.join(dir, '..', 'core.cjs'))) return true;
    return false;
  } catch { return false; }
}

/** 当前运行目标：argv[1] 经 realpath 消解 symlink。 */
function runningTarget() {
  try {
    const a1 = process.argv[1];
    if (!a1) return null;
    return fs.realpathSync(path.resolve(a1));
  } catch { return null; }
}

/** 部署形态判定。
 *  form: 'launcher'（标准，可自更新）/ 'sea-binary'（历史兼容，可自更新）/
 *        'source-shell'（源码开发，不可自更新）/ 'unknown'（无法判定，保守禁用）。 */
function detect() {
  // 测试/CI 注入口：强制形态；生产不设置该变量，走真实判定。
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
  // 有 core.cjs 即标准产品形态；无则是 node 脚本壳指向源码目录，npm i -g 的新包与其无关。
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
