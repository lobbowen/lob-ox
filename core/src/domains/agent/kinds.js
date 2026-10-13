'use strict';

// agent 的两种部署形态。这是 agent 管理系统的一等概念，不是 instance 上的一个字段。
//
//   native    原生安装：npm 全局/共享 prefix，数据落 dshHome（用户主目录下的产品数据根）。
//             启动快、无额外磁盘开销，但多个 native agent 共享同一份用户级状态。
//   sandbox   沙箱化：每 agent 独立 install/ + data/ + tmp/，env 全量重定向。
//             数据彼此隔离（各自独立数据目录），磁盘与启动开销略高。
//
// 铁律：形态决定「数据落点」与「env 重定向范围」，**不决定**业务语义——
//   安装/卸载/升级/启停/入口定位五件套在两种形态下是同一套代码，
//   差异只由 runtime 层吸收。这是把 agent 管理从 instance 里收拢出来的前提。

const NATIVE = 'native';
const SANDBOX = 'sandbox';

const KINDS = [NATIVE, SANDBOX];

function isKind(v) { return KINDS.includes(v); }

// 形态能力矩阵：UI 据此展示「这个 agent 的数据在哪、能否隔离」，
// 而不是让前端自己拼字符串。容器化隔离不在矩阵内——当前只做数据隔离，
// 安全隔离（容器/namespace）是后续独立议题。
const CAPABILITIES = {
  native: {
    dataIsolation: false,   // 数据落共享 dshHome
    installIsolation: false,
    label: '原生安装',
    dataLabel: '共享数据目录（dshHome）',
  },
  sandbox: {
    dataIsolation: true,    // 每 agent 独立 data/
    installIsolation: true, // 每 agent 独立 install/
    label: '沙箱化',
    dataLabel: '独立数据目录（每 agent 一份）',
  },
};

function capabilitiesOf(kind) { return CAPABILITIES[kind] || CAPABILITIES[NATIVE]; }

// 归一化：缺省按 native（与历史行为一致——instance.domain 缺省即原生）。
function normalizeKind(v) { return isKind(v) ? v : NATIVE; }

module.exports = { NATIVE, SANDBOX, KINDS, isKind, normalizeKind, capabilitiesOf };