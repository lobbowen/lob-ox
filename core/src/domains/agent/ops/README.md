# agent/ops —— 生命周期五件套

本目录承载 agent 的安装/卸载/升级/启停/入口定位。**从两处并行的实现收拢而来**：

| 目标文件 | 来源 | 原位置 |
|---|---|---|
| `install.js` | npm 安装 + 前缀解析 | `domains/instance/ops/dsh-install.js` + `app/native/npm.js` |
| `uninstall.js` | 卸载编排 + 越界保护 | `app/native/ops.js` 的 uninstall |
| `upgrade.js` | 升级编排 + 回滚 | `domains/instance/upgrade.js` + `app/native/upgrade.js` |
| `entry.js` | 入口定位（dshBin/已知入口/PATH） | `platform/os/exec-path.js` 的 dshJsIn/knownDshEntries |
| `lifecycle.js` | 启停 + 就绪判定 | `domains/instance/lifecycle.js` 的 DSH 部分 |
| `status.js` | 状态与版本信息 | `app/native/policies.js` + `probe.js` |

## 迁移原则

1. **先立域，后迁代码**：index.js 已就位，ops 各文件逐个迁，每迁一个跑全量测试。
2. **不为迁移改行为**：迁移期的目标是归属正确，不是重构。行为变更单独提交。
3. **两种形态同一套代码**：install/upgrade/lifecycle 不得出现 `if (kind === 'sandbox')`
   分支——差异由 `runtime/` 吸收（env 重定向、目录落点）。

## 当前状态

- [x] kinds.js 形态判别与能力矩阵
- [x] model.js 纯函数（归一化/落点/隔离判定）
- [x] runtime/sandbox-env.js 数据隔离（含 Windows USERPROFILE 补口）
- [x] index.js 门面
- [ ] ops/* 待迁移
