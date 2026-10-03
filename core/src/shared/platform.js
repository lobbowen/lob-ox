'use strict';

// 平台三态：全域唯一一份（与 brand.js 的其它常量同层，放 shared/ 便于 pure 文件依赖）。
// 为什么单独抽出来：platform/os/index.js 里的 isWindows 虽是纯常量，但那个模块整体有副作用
// （require exec/desktop/capability-profile 等）⇒ 被契约声明为 pure 的文件**不能**依赖它。
// 此前 domains/instance/sandbox.js 因此出现了两难：要么违反 pure 声明，要么自己抄一份
// `process.platform === 'win32'`（第三份平台判定）⇒ 正是「同一事实多份」的病根。
// 抽到 shared 后：pure 文件可安全依赖；platform/os/index.js 改为转调 ⇒ 只剩一份。
const PLATFORM = process.platform;

const isLinux = PLATFORM === 'linux';
const isMac = PLATFORM === 'darwin';
const isWindows = PLATFORM === 'win32';

module.exports = { PLATFORM, ARCH: process.arch, isLinux, isMac, isWindows };
