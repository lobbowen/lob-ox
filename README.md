# lobox

DSH Supervisor —— **内核与桌面壳合仓**。

本仓由两个原仓合并而来，**对使用者的交付结构完全不变**：

| 组件 | 目录 | 原仓 | 交付物（不变） |
|---|---|---|---|
| **内核** | [`core/`](core/) | `dsh-supervisor-core` | npm 子包 `@dsh-sup/dsh-core-{linux-x64,darwin-arm64,darwin-x64,win-x64}` |
| **桌面壳** | [`shell/`](shell/) | `dsh-supervisor-launcher` | Tauri 四平台安装包 + npm 壳包 |

⇒ **发布仍然是一份壳、一份内核**，只是源码同仓、CI 按目录分跑。

---

## 为什么合仓

原先是两个仓，跨仓的每次协作都要靠"禁止互读源码 + 只经契约产物对接"来维持；实际结果是**两边的 CI 各自演化、门禁各写一套、跨仓一致性无人核对**。合仓后：

1. **一次改动一次 CI**：按目录 path filter 触发，内核改动不触发壳的四平台打包，反之亦然；
2. **跨语言契约可在同一仓内核对**（版本向量、`identity.json`、端口段、`managed-objects.json` schema）；
3. **流程只有一套**：分层、构建、验收、发布的口径统一。

⚠️ **仍然保留的纪律**：`core` 与 `shell` 在**运行时**只经「已发布产物 / schema / 测试向量」对接，**不互相读源码**。这条不再由门禁强制（原门禁体系已整体拆除），而是**约定 + code review 责任**。

---

## 目录

```
lobox/
├─ core/                    内核（Node.js，CommonJS，零运行时依赖）
│   ├─ src/                 产品代码（domains / app / platform / api / shared）
│   ├─ test/                测试（entry = test/_runner.js，登记表 = test/manifest.js）
│   ├─ bin/dsh-supervisor   CLI + 启动器
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
| Windows | `%LOCALAPPDATA%\dsh-supervisor` |
| macOS | `~/Library/Application Support/dsh-supervisor` |
| Linux | `$XDG_STATE_HOME/dsh-supervisor`，否则 `~/.local/state/dsh-supervisor` |

其下 `supervisor/`（内核）与 `shell/`（壳）两份子目录，schema 常量 `1` 两侧一致。

## 本仓不含门禁

原两仓各有一套「门禁」测试（源码/文档文本断言 + CI 强制），已于 2026-10 整体拆除（移至仓外备份）。**现状**：

- 断言只保留「**pass/fail 由真实执行决定**」的行为测试；
- 原先由门禁承载的若干约束（版本号三处一致、API 契约表与源码对账、测试分层标注核对、SKIP 台账）**现在无人自动校验**，改由 code review 与发布流程人工确认。
