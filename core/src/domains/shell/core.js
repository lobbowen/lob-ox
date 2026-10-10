'use strict';

// 壳判据（PROC_MATCH_GUI / isShellProcess / decide / exeFromCmdline）已迁至
// 壳侧单源（shell/src-tauri/src/brand.rs）——内核不再 pgrep 自己的父进程（壳），
// 亦不再跨会话拉起 GUI 壳（倒挂修复）。内核对壳只作只读聚合（见 journal.js / index.js）。

function isUpdatePhase(phase) {
  const p = String(phase || '');
  return p === 'restarting' || p.indexOf('shell-update') === 0;
}

function deriveState(id, journal) {
  const j = journal || {};
  if (!j.to) return { state: 'idle', reason: '无进行中的更新', journal: j, identity: id };

  const cur = id && id.version ? String(id.version) : null;

  if (cur && cur === j.to && id && id.phase === 'ready') {
    const next = j.confirmed === true ? j : Object.assign({}, j, { confirmed: true });
    return { state: 'confirmed', version: cur, reason: '壳已健康运行新版本', journal: next, identity: id };
  }

  return {
    state: 'pending',
    target: j.to, current: cur,
    reason: cur === j.to ? '等待壳上报就绪' : '等待壳重启到新版本',
    journal: j, identity: id,
  };
}

module.exports = { isUpdatePhase, deriveState };
