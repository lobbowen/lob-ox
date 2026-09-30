'use strict';

// app/daemons/process-marks.js —— cmdline 标记派生（纯模块：无 IO、无 this）。

/** 从 script 派生权威 cmdline 标记：daemon 真实 cmdline 形如 `node <script> ...`，只按调用方语义 cmdMark 匹配会恒失配
 *  （_ctlOwnerPid() 恒 null，换代分支永不执行，classify 的 external/reclaiming 永不可达），故从 script 派生标记与语义标记并列，脚本位置演进时自动跟随。
 *  @param {string} script spawn 脚本绝对路径 @param {string} [cmdMark] 语义标记 @returns {string[]} 语义名 + 绝对路径 + 相对包根尾段 */
function deriveCmdMarks(script, cmdMark) {
  const norm = (s) => String(s || '').replace(/\\/g, '/');
  const marks = [];
  if (cmdMark) marks.push(String(cmdMark));
  if (script) {
    // 绝对路径原样（spawn 用的就是它）
    marks.push(norm(script));
    // 相对包根的尾段（处理 cwd/相对调用差异）
    const m = /[/\\](src[/\\][^\s]+|domains[/\\][^\s]+)$/.exec(norm(script));
    if (m) marks.push(m[1]);
  }
  return marks;
}

module.exports = { deriveCmdMarks };
