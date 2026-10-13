# agent/ops —— 生命周期五件套

状态：**已全部落地**（2026-10-13）。原 app/native/ 整套 DSH 管理实现已删除，
domains/instance/ops/dsh-install.js 的重复逻辑已委托本域。

| 文件 | 职责 | 原位置（已删） |
|---|---|---|
| `entry.js` | 入口定位（按形态选候选，不碰平台探测） | `platform/os/exec-path.js` 的 dshJsIn/knownDshEntries 包装 |
| `install.js` | npm 安装 + 版本查询 + 环境自检 | `app/native/npm.js` + `domains/instance/ops/dsh-install.js` |
| `upgrade.js` | 升级编排 + 回滚（env 显式注入） | `app/native/upgrade.js` + `domains/instance/upgrade.js` |
| `uninstall.js` | 卸载 + 越界保护 | `app/native/ops.js` 的 uninstall |
| `lifecycle.js` | 启停 + 就绪判定（薄分派层） | 新建（不搬 instance/lifecycle.js，见下） |

## 边界：为什么不搬 domains/instance/lifecycle.js

那个文件与沙箱实例深度耦合（store.instances / governor 配额 / stateMachine 相位 /
sandbox.launchCtx / systemd unit 命名），是「沙箱实例」这一种形态的进程编排，
不是 agent 通用生命周期。搬过来会把 instance 的耦合带进 agent 域。
ops/lifecycle.js 只做「按形态选启动方式 + 收拢就绪判定」。

## 设计铁律

1. **形态只决定数据落点与 env 重定向范围**，不决定业务语义。
   install/upgrade/uninstall/lifecycle 内不得出现 `if (kind === 'sandbox')` 分支
   ——差异由 runtime/ 与 model.js 吸收。
2. **不复制平台能力**。PATH/注册表/shim 解析留在 platform/os/exec-path.js，
   npm 全局前缀探测留在 platform/contract/runtime.js。
3. **包名不假定**。agent 域不绑定 DSH：isBareCommand 等判据与产品名无关，
   包名由调用方经 product.pkg 传入。

## 测试

每个 ops 文件有对等测试（core/test/agent-*-test.js），另见
`assembly-integration-test.js` 验证删旧实现后装配链仍完整。