'use strict';

// 任务终态 → 视图态：全域唯一一份。
// W3 前有三份逐字等价的副本（instance/model.js#taskStateToView、plugin/model.js#taskStateToJobState、
// router/ops/apps-registry.js 内联三元式），分属三个域 ⇒ 改口径必漏两处。
// 放在 shared/ 而不是任一域内：三个消费域互不应依赖彼此（域间不横穿），共用规则只能放在共享层。
//
// 映射（已证三份逐字等价，12 个输入零分歧）：
//   succeeded / skipped → done
//   failed / canceled   → failed
//   其他一切            → running（含 null/undefined/未知态：未终态即视为在跑，不谎报完成）
function taskStateToView(s) {
  return (s === 'succeeded' || s === 'skipped') ? 'done' : (s === 'failed' || s === 'canceled') ? 'failed' : 'running';
}

module.exports = { taskStateToView };
