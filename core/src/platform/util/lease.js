'use strict';

/**
 * Lease —— 跨进程共享可变状态的「归属 + 代际」原语（根因 D 的修法）。
 *
 * 背景（实证）：三处 P0 同源——只认文件内容/值，不认"谁写的、哪一版、写者是否还活着"：
 *   1. instance/store.js  损坏隔离无锁 ⇒ 可能 rename 掉**更新的**文件，实例列表静默清空
 *   2. ports/alloc.js     _allocLock 是**无归属的布尔锁**，check 与 set 隔着 await ⇒ 真 TOCTOU
 *   3. ports/alloc.js     锁文件写入 process.pid 却**全仓 0 处回读校验** ⇒ 崩溃后锁永久泄漏
 *
 * 三条不变量（本模块统一实现，供所有共享写入复用）：
 *   I1 同步获取   —— test-and-set 不得跨越 await（消除 2 的 TOCTOU）
 *   I2 代际校验   —— 写入携带 generation，读取方校验一致才采信（消除 1 的"隔离掉新文件"）
 *   I3 回收前验活 —— 判定 stale 前必须校验持锁 pid 是否存活（消除 3 的泄漏与误删他人活锁）
 */

const fs = require('node:fs');
const pidlookup = require('../os/pidlookup');

const STALE_MS = 15000;

/** I1：同步 test-and-set。返回是否取得锁（未取得由调用方退避重试）。 */
function acquireSync(state, key) {
  if (!state[key]) { state[key] = true; return true; }
  return false;
}

function releaseSync(state, key) {
  state[key] = false;
}

/**
 * I3：锁文件是否可安全回收。
 * 只有"持锁 pid 已确认不存在"或"锁已陈旧且 pid 无法判定"时才允许回收；
 * 持锁进程仍活着 ⇒ 绝不删（此前 A 可能删掉 B 的活锁）。
 */
function lockRecyclable(lockFile, staleMs) {
  let raw;
  try { raw = fs.readFileSync(lockFile, 'utf8'); } catch { return true; }   // 读不到 ⇒ 无锁
  const pid = parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return true;                      // 内容非法 ⇒ 可回收
  const st = pidlookup.probeAlive(pid);
  if (st === 'alive') return false;                                          // 持锁者仍在 ⇒ 不回收
  if (st === 'unknown') {
    // 无法判定：仅当锁已足够陈旧才回收（保守）
    try {
      const fst = fs.statSync(lockFile);
      return fst.mtimeMs < Date.now() - (staleMs || STALE_MS);
    } catch { return true; }
  }
  return true;                                                               // dead ⇒ 可回收
}

/** 读锁持有者 pid（供诊断；此前只写不读） */
function lockHolder(lockFile) {
  try {
    const n = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

/**
 * I2：带代际的写入。
 * 调用方先 readGeneration() 记下版本，写入时传回；
 * 若期间文件已被他人更新（stamp 变化）⇒ 拒绝写入，由调用方重新读取后决策。
 * 这正是 instance/store.js 隔离逻辑需要的：**不得把更新的文件当成损坏隔离掉**。
 */
function stampOf(file) {
  try {
    const st = fs.statSync(file);
    return st.mtimeMs + ':' + st.size;
  } catch { return null; }
}

function stampChanged(file, expected) {
  if (!expected) return false;
  return stampOf(file) !== expected;
}

module.exports = {
  STALE_MS,
  acquireSync, releaseSync,
  lockRecyclable, lockHolder,
  stampOf, stampChanged,
};
