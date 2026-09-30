'use strict';

// 源文件定位器（单一真源）：用存在性验证代替脆弱的相对路径推算。候选根逐个验证
// 「根下确实存在本模块自身」，第一个通过者胜出；全部不成立返回 null，调用方据此降级。
// 只做通用路径能力，业务域名词的映射在 app/daemons/scripts.js。

const fs = require('node:fs');
const path = require('node:path');

/** 本模块相对 src/ 的位置，作为候选根的通用存在性判据（不含任何业务域名词）。 */
const SELF_REL = path.join('platform', 'util', 'srcpath.js');

/** 候选 src/ 根（按可信度排序）。判据统一为「该根下存在 SELF_REL」，与实际布局解耦。 */
function _candidateRoots() {
  return [
    { label: '__dirname/../..', path: path.join(__dirname, '..', '..') },
    { label: '__dirname/../../../src', path: path.join(__dirname, '..', '..', '..', 'src') },
    { label: 'cwd/src', path: path.join(process.cwd(), 'src') },
  ];
}

let _root = null; // 解析结果缓存（进程内不变）

/** 定位包内 src/ 目录；全部候选不成立时返回 null。 */
function resolveSrcRoot() {
  if (_root) return _root;
  for (const p of _candidateRoots()) {
    if (fs.existsSync(path.join(p.path, SELF_REL))) {
      _root = p.path;
      return _root;
    }
  }
  return null;
}

/** 把相对 src/ 的路径解析为真实存在的绝对路径；不存在时返回 null（调用方据此降级）。
 *  参数中的域名词由 app/daemons/scripts.js 注入。 */
function resolve(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return null;
  const root = resolveSrcRoot();
  if (!root) return null;
  const p = path.join(root, relPath);
  return fs.existsSync(p) ? p : null;
}

/** 诊断用：所有候选根及其成立情况（供 --self-check 与门禁输出）。 */
function describe() {
  return {
    resolved: resolveSrcRoot(),
    candidates: _candidateRoots().map((p) => ({
      label: p.label,
      path: p.path,
      selfModule: fs.existsSync(path.join(p.path, SELF_REL)),
    })),
  };
}

/** 定位包根（含 package.json 的目录）。从本模块位置逐级上溯，比固定层数稳健；
 *  兜底 cwd（开发态直接 node src/... 运行）。 */
function resolvePackageRoot() {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (fs.existsSync(path.join(process.cwd(), 'package.json'))) return process.cwd();
  return null;
}

module.exports = { resolve, resolvePackageRoot, describe };
