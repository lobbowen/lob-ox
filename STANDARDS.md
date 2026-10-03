# STANDARDS —— 本仓开发规范（只写机器判不了的操作要求）

可执行的部分在 [`core/ci/standards-check.js`](core/ci/standards-check.js)：`core.yml` 的 `precheck` job 每次跑，违规即红并指出 `文件:行号`。
自动化覆盖 R2 复现入口 · R3 禁止自证 · R5 登记 why · R6 登记表↔磁盘两向零差 · R9 禁止假绿 · R10 自证窗口下限 · **R11 域契约一致性** · **R12 安装期安全不变量** · **R13 测试端口分配** · **R14 端口安全段** · **R15 空闲端口单实现** · **R16 禁止恒真断言** · **R17 登记表↔宿主依赖一致**；豁免在执行输出里逐条列出。
下面十二条靠人执行；违反任一条，本轮改动不算完成。

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