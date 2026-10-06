# lob-ox 产品定位与术语规范（唯一权威）

## 一、产品是什么

**lob-ox 是一套 Agent 的跨平台管理面板。**

- 形态：桌面壳（Tauri / Rust）+ 内核（Node），向下**监管**一批服务。
- 管理对象：内核自身、DSH 主实例、路由 daemon、局域网 daemon、沙箱实例、插件。
- 平台：Windows / macOS / Linux。
- 关键词：**管理**、**监控**、**跨平台**、**面板**。
- **不是**守护程序，**不是**看护程序，**不是**守护进程。

## 二、术语表（全仓唯一口径）

| 正确用词 | 禁用词 | 含义 |
|---|---|---|
| 监控（monitor） | 守护、看护、监护 | 观测并上报服务状态 |
| 监控器（monitor） | 服务管理器 | 产品自身的服务汇总 / 监控 / 生命周期 / 进程管理模块 |
| 受管服务（managed service） | 被守护进程 | 向下被管理的服务单元 |
| 受管对象（managed object） | 被守护对象 | 向下被管理的对象 |
| 接管（adopt） | 守护启动、拉起 | 纳管已存在的外部服务实例 |
| 版本对齐（align） | 更新分发 | 使磁盘内核与线上最新一致 |

## 三、服务管理器 = 产品自身的监控器

服务管理器是 lob-ox **自己建立**的一套机制，与操作系统没有任何关系：

- 它不是 Windows 计划任务 / systemd / launchd 的封装或借用
- 不存在"用系统通道投递服务"的选项
- 它统一负责：向下所有子服务模块的**汇总、监控、生命周期管理、进程管理**

### 两面分工（同一套机制的两个面，不得混用）

- **生命周期 / 进程管理**（`platform::service::ServiceControl`）：登记、接管（adopt）、启动、
  停止、汇总。进程**由本产品自己持有**——不向 systemd / launchd / 任务计划程序投递
  任何东西，全仓不得出现 schtasks / systemctl / launchctl / LaunchAgent 一类的调用。
- **监控**（`--watchdog` / `guardctl::ready` / `panel_watch_tick`）：**只观测**
  （在不在 / 端口 / 版本 / 健康），不做任何拉起、强杀、改生命周期的动作。

### 端口不变量

受管对象的真实端口在**接管时探测**（登记表取内核自报的 ports.json），不预设、不锁死。
为拉起而占用固定端口会让受管对象顺延不了端口，进而让监控永远打在没人监听的端口上。

### 范围边界（明确不算「服务管理器」的两件事）

- **开机/登录自启**（`core/src/platform/os/autostart/*`）：让用户登录后自动拉起面板，
  属独立能力，不在「汇总 / 监控 / 生命周期管理 / 进程管理」四项职责里，保留现实现。
- **被监管产品自身的机制**：`dsh-web@.service` 这类属**被监管产品**的东西，本产品不改其语义；
  只保证不把自己的服务管理器架在它们之上。

### 代价（如实声明）

不借 systemd 的 cgroup ⇒ 沙箱实例不再有内存/CPU 的 cgroup 级强制（限额档位如实为 `supervise`）。
资源约束改由产品自身的监控与限流承担，不以「借 OS 通道」换回这一能力。

---
# STANDARDS —— 本仓开发规范（只写机器判不了的操作要求）

可执行的部分在 [`core/ci/standards-check.js`](core/ci/standards-check.js)：`core.yml` 的 `precheck` job 每次跑，违规即红并指出 `文件:行号`。
自动化覆盖 R2 复现入口 · R3 禁止自证 · R5 登记 why · R6 登记表↔磁盘两向零差 · R9 禁止假绿 · R10 自证窗口下限 · **R11 域契约一致性** · **R12 安装期安全不变量** · **R13 测试端口分配** · **R14 端口安全段** · **R15 空闲端口单实现** · **R16 禁止恒真断言** · **R17 登记表↔宿主依赖一致** · **R18 镜像源上下流契约** · **R19 跨目录重复脚本** · **R20 lockfile 可复现性** · **R21 全局落点一致性**；豁免在执行输出里逐条列出。
下面十六条靠人执行；违反任一条，本轮改动不算完成。

- **R1 验收只在 CI 四平台**：不跑整套测试当验收；不以本机绿灯为放行依据；不以本机红灯为由改代码。
- **R2 CI 等价复现**：定位与突变验证只用 `node test/_runner.js --only=<file>`（该文件须已登记）；它不是验收。
- **R4 测试突变验证**：新增或修改测试后，故意改坏被测点 ⇒ 必须红 ⇒ 还原；提交附「改前/改后 SHA256 相同」的证据。
- **R7 跨语言单源一致性**：必须比边界输入（空串、纯空白、缺值、超长、大小写）的行为，不只比常量与名字集合。
- **R8 单一事实源单写者**：`core/test/manifest.js`、`core/package.json#version`、`core/src/shared/brand.js` 与
  `shell/src-tauri/src/brand.rs` 只由单写者改；代理不得代改，要改就提出登记请求（file/tier/os/why）。
- **R11 域契约一致性**：`core/src/domains/*/contract.js` 是**门禁，不是文档**。契约声明的 `exports` / `PUBLIC_API` / `classApi` / `pure` / `deps` 每次 CI 逐条对账：
  声明了必须存在（不许"声明了却没实现"），实现了必须入契（不许"实现了却没入契"）⇒ **双向零差**；
  `pure` 声明的文件不得引入副作用模块（`platform/os`、`platform/service`、`util/exec`、`distribution`、`security`、`app/`、`node:fs/net/http` 等）。
  豁免写在契约自己的 `exempt` 字段里且**必须带理由**，每次运行都列出，不静默通过。
  改契约或改域的对外面 ⇒ 两边必须同一次提交改完，否则 `precheck` 直接红。
- **R12 安装期安全不变量**：安全相关的开关不得只写在一条代码路径上。
  `--ignore-scripts` 必须声明为共用常量（`IGNORE_SCRIPTS_FLAG`），并被**两条安装路径共同引用**
  （`commandTemplate` 分支 + 默认分支）；用户显式写了 `--no-ignore-scripts` 时尊重用户，不强行覆盖。
  判据在 `standards-check.js`，行为断言在 `uninstall-timeout-behavior-test.js`（W2-A/B/C）。
- **R13 测试端口分配**：测试里**真会 bind 的端口**一律走 `test/_ports.js#safePort('<段名>', i)`，不得硬编 `.listen(<数字>)`。
  段名须在 `SEGMENTS` 登记；`_ports.js` 本身豁免。
  ⚠️ 刻意不管 `healthUrl`/`apiPort` 里的常量：它们多是不真监听的假数据或有语义的产品默认值（如 3080）⇒ 一并禁止会制造大片误报（已实测）。
- **R14 端口安全段**：`_ports.js#isSafe` 是规范，接进门禁真跑 —— 所有登记段 × 10 个偏移必须落在 `[BASE, BAND_HI)` 内。
  `BAND_HI` 必须是**绝对常量**（硬写整数，不引用 `BASE`、不由 `SEGMENTS` 推导）⇒ 否则判据随被判对象自证其说、永不红（已实测两次）。
- **R15 空闲端口单实现**：取空闲端口的唯一实现是 `test/_ports.js#freePort`，测试不得各自重写 `const freePort = ...`。
  （此前 4 个测试各写一份且行为各异：用 `http` / 用 `net` / 出错返回 `0` ⇒ 同一件事四份实现。）
- **R16 禁止恒真断言（假绿防线）**：断言判据不得写成 `!X || <真判据>` —— X 不成立时整条恒真，判据**从未执行却计入 PASS**。
  最危险的是 X 依赖宿主环境（LAN 地址、`/proc`、平台）⇒ CI 上永远绿、永远没验。
  正解：条件成立才 `check`，否则 `skip`；`skip` 必须显式统计并打印（不得静默丢弃）。
- **R17 登记表↔宿主依赖一致**：标 `L1`（只在 ubuntu 跑一遍）的测试不得含「平台分支决定期望值」的依赖 ——
  否则它在 win32/darwin **从未执行**，而登记表声称已覆盖。判据在 `standards-check.js`。
  豁免走 `R17_EXEMPT`（带理由、每次运行列出、**不命中即判红**，防止豁免留着不修）。
  当前 1 条豁免：`brand-single-source-test.js`（应由单写者把 manifest 的 tier 改 L2、os 改 all —— `manifest.js` 是 R8 单写者文件）。

- **R18 镜像源上下流契约**：壳 `mirror.rs#NPM_PRESETS`（装机前探测候选）必须**覆盖**内核 `config.js#registries` 默认项。
  两者语义不同（上下流，非重复），故**不要求相等**；只要求覆盖（否则装机首启可能选到未探测源）。顺序无关（壳并行探测 + 取最高版本）。
- **R19 跨目录重复脚本**：`core/ci/` 与 `shell/ci/` 下的同名脚本，若规范化后逻辑逐行相同 ⇒ 判为重复，须改为转发单源（转发器 `exec bash` 不算重复）。

- **R20 lockfile 可复现性**：`package-lock.json` 的 `resolved` 必须全部指向 `https://registry.npmjs.org/`。
  `npm ci` 按 `resolved` 精确取包 ⇒ 硬编镜像 URL 时该镜像不可达即构建失败（已发生：win-x64 因腾讯镜像 ETIMEDOUT 未发布）。
  lockfile 应对 registry 中立，取包地址交由 npm 配置决定，`integrity` 负责校验。

- **R21 全局落点一致性**：工具链（Node/DSH）必须装到**用户级全局目录**并登记进 PATH，不得私有化到状态根。
  落点常量 `GLOBAL_APP_DIRNAME` / `GLOBAL_BIN_DIRNAME` 在内核（`exec-path.js`）与壳（`env.rs`）各一份、逐字相同；
  三平台安装必须走 `node_install_target()`（全局），不得退回 `node_install_root()`（私有状态根）。
  机器级目录（Program Files / /usr/local）无管理员时不可写 ⇒ 只取用户级。