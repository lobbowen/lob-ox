# STANDARDS —— 本仓开发规范（只写机器判不了的操作要求）

可执行的部分在 [`core/ci/standards-check.js`](core/ci/standards-check.js)：`core.yml` 的 `precheck` job 每次跑，违规即红并指出 `文件:行号`。
自动化覆盖 R2 复现入口 · R3 禁止自证 · R5 登记 why · R6 登记表↔磁盘两向零差 · R9 禁止假绿 · R10 自证窗口下限 · **R11 域契约一致性** · **R12 安装期安全不变量**；豁免在执行输出里逐条列出。
下面七条靠人执行；违反任一条，本轮改动不算完成。

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