# lob-ox

lobox —— 内核与桌面壳同仓的项目。

| 组件 | 目录 | 交付物 |
|---|---|---|
| **内核** | [`core/`](core/) | npm 子包 `@lob-ox/core-{linux-x64,darwin-arm64,darwin-x64,win-x64}` |
| **桌面壳** | [`shell/`](shell/) | Tauri 四平台安装包 + npm 壳包 |

⇒ **发布是一份壳、一份内核**：源码同仓，CI 按目录 path filter 分跑（内核改动不触发壳的四平台打包，反之亦然）。

⚠️ **运行时边界**：`core` 与 `shell` 只经「已发布产物 / schema / 测试向量」对接，**不互相读源码**；这条边界由**约定 + code review** 维持。

---

## 目录

```
lob-ox/
├─ core/                    内核（Node.js，CommonJS，零运行时依赖）
│   ├─ src/                 产品代码（domains / app / platform / api / shared）
│   ├─ test/                测试（entry = test/_runner.js，登记表 = test/manifest.js）
│   ├─ bin/lobox   CLI + 启动器
│   ├─ ui/                  内嵌面板（构建产物由 core 自己消费）
│   ├─ release/             产线脚本（build / publish / credentials）
│   └─ ci/                  CI 用夹具与脚本
├─ shell/                   桌面壳（Rust + Tauri v2）
│   ├─ src-tauri/           Rust 源码 + 集成测试
│   ├─ bootstrap/           引导页与壳内页面
│   ├─ scripts/             版本提升等脚本
│   └─ ci/                  安装冒烟等
└─ .github/workflows/
    ├─ core.yml             内核：test（L1）→ 四平台 build → precheck → release
    └─ shell.yml            壳：version → 四平台 build（含 cargo test）→ 产物验收 → release
```

## 测试

- **唯一入口**：`core/test/_runner.js`，读 `core/test/manifest.js` 的登记表逐条起子进程。
- **分层**：`L1` 平台无关（CI 在 ubuntu 跑一遍）；`L2` 依赖真实宿主（在 `os` 列出的每个平台真跑）。
- **本机不跑**：本仓的验收**只由 CI 裁决**。本机运行不产生验收证据（环境、平台、依赖都不可复现）。
- 被测产品的状态根由 `core/test/_preload.js` 注入临时目录（`DSH_SUPERVISOR_HOME`），**不会碰真实安装**。

## 状态根（运行时）

`DSH_SUPERVISOR_HOME` 可覆盖；默认：

| 平台 | 路径 |
|---|---|
| Windows | `%LOCALAPPDATA%\lobox` |
| macOS | `~/Library/Application Support/lobox` |
| Linux | `$XDG_STATE_HOME/lobox`，否则 `~/.local/state/lobox` |

其下 `supervisor/`（内核）与 `shell/`（壳）两份子目录，schema 常量 `1` 两侧一致。

⚠️ **旧状态根不迁移（产品改名的一次性后果）**：改名前的状态根（旧目录名 `dsh-supervisor`，同上三平台基座）**不会**被搬进新根 ——
新版本从空态开始，旧根里的 `state.json` / `ports.json` / `install-id` / 远程令牌 / 日志一律留在原处。
这条是**明确行为而非静默忽略**：内核启动时会记一条日志与 `legacy_state_root_detected` 事件；
若旧版守卫仍在运行（旧锁 + 存活 pid），新内核**拒绝启动**并提示先卸载旧版本（防双守卫）。
旧根确认不再需要后手工删除即可。判据与断言见 `core/src/shared/brand.js#LEGACY_PRODUCT_NAME`、
`core/src/platform/service/state-root.js#detectLegacyInstall`、`core/test/brand-single-source-test.js` H 段。

## 校验范围

本仓不设「门禁」测试（源码/文档文本断言 + CI 强制）这一层：

- 断言只保留「**pass/fail 由真实执行决定**」的行为测试；
- 版本号三处一致、API 契约表与源码对账、测试分层标注核对、SKIP 台账这几项约束**无人自动校验**，由 code review 与发布流程人工确认。
