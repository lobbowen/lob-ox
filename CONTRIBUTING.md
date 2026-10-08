# 贡献指南

## 前置条件

- **Node.js**：≥ v22.12.0（见 `shared/shared-constants.json` 的 `runtime.minNode`）
- **Rust**（仅改动 `shell/` 时）：stable，且需 Tauri v2 的系统依赖
- **平台**：linux-x64 / darwin-arm64 / darwin-x64 / win-x64 四组受支持（见 `shared/shared-constants.json` 的 `core.pkgTags` 对应表）

## 仓库结构

```
lob-ox/
├── core/      Node 内核（守卫进程 + HTTP API + 面板）
├── shell/     Rust/Tauri 桌面壳
└── shared/    跨语言共享常量（数据文件，Node 与 Rust 同读）
```

## 开发流程

1. Fork 并建分支
2. 改动后**必须**跑通本地门禁（见下）
3. 提交 PR，说明改动动机与影响面；涉及跨语言常量时请说明是否改了 `shared/shared-constants.json`

## 本地门禁（提交前必跑）

```bash
# 1) 自建标准检查（20+ 条规则，见 core/ci/standards-check.js）
node core/ci/standards-check.js

# 2) 全量测试（登记表驱动，见 core/test/manifest.js）
node core/test/_runner.js

# 3) 单文件复现（调试用）
node core/test/_runner.js --only=<文件名>

# 4) 改动 shell/ 时
cd shell/src-tauri && cargo test && cargo clippy
```

### 门禁规则体系（简要）

`core/ci/standards-check.js` 是本仓的**自建标准门禁**，规则编号 R2–R25，覆盖：

| 规则 | 检查内容 |
|---|---|
| R3 | 反自证断言（期望值不得由被测实现算出） |
| R6 | 测试登记表与磁盘两向零差 |
| R11 | 域契约（`contract.js`）与实现双向对账 |
| R16 | 恒真假绿（断言不得形如 `!X \|\|`） |
| **R23** | **未声明标识符**（防"重构删定义漏删引用"复发） |
| **R24** | **判据类空 catch**（防"失败被吞当成成功"） |
| **R25** | **Outcome 三态不得塌成布尔/null 判据** |
| R22 | 术语门禁：产品是管理面板，一律称"监控"（见 `STANDARDS.md` 术语表；本表不重述被禁用词以免自指触发） |

**注意**：R16 当前存在"只扫单行"的盲区（跨行 `check(` 不可见），正在修复中。
新增规则时请务必做**正向（注入问题）+ 反向（干净代码）**双重验证——
**假门禁比没有门禁更危险**，它会给出虚假的安全感。

## 编码约定

### 跨域常量

**新增跨语言常量时，一律加到 `shared/shared-constants.json`**，不要：
- 在 `core/src/shared/brand.js` 与 `shell/src-tauri/src/brand.rs` 各写一份
- 在消费点硬编码字面量

理由：两侧各存一份只能靠对账**发现**漂移、不能**防止**漂移；数据文件是结构性消除。

### 返回三态而非布尔

凡"成功 / 失败 / 未知"语义的函数，返回 `Outcome`（见 `core/src/shared/outcome.js`），
调用方用 `isOk` / `isFail` / `isUnknown` 显式处置。**禁止**用 `!== false`、`=== true` 判成败
（R25 会拦）。

### 平台能力先问后用

需要平台能力（如强制内存/CPU 限额）时，先 `service.supports(cap)` 协商，
不支持则降级为观测/告警，**不得**假定支持并据此做破坏性处置（如重启）。

### 进程构造

一律经 `ProcessSpec.build()`（`core/src/platform/os/process-spec.js`）。
安全不变量（`--ignore-scripts`、参数白名单、端口覆盖语义）内置于构造器，
不要在调用点手工拼 argv。

### 注释

注释用于说明**为什么**，不重复**做了什么**。本项目要求注释如实反映代码行为；
若发现注释与代码不符，以代码为准并修正注释。

## 测试约定

- 新测试必须登记到 `core/test/manifest.js`（R6 会检查两向一致）
- 断言不得"自证"（R3）：期望值应是字面量，不得由被测实现算出
- 端口不得硬编码（R13/R14）：用 `test/_ports.js` 的 `safePort` / `freePort`
- 环境不具备条件时**必须 `skip()`**，不得写成恒真断言（R16）

## 提交信息

建议格式：`<scope>: <动词> <对象>`，如：

```
core/ports: 端口锁回收前校验持锁进程存活
shell/brand: 跨语言常量改为读取 shared-constants.json
```

## 许可证

本项目采用 **MIT**（见 `LICENSE`）。提交贡献即表示你同意按该许可证授权你的贡献。
