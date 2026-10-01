# STANDARDS —— 本仓开发规范（只写机器判不了的操作要求）

可执行的部分在 [`core/ci/standards-check.js`](core/ci/standards-check.js)：`core.yml` 的 `precheck` job 每次跑，违规即红并指出 `文件:行号`。
自动化覆盖 R2 复现入口 · R3 禁止自证 · R5 登记 why · R6 登记表↔磁盘两向零差 · R9 禁止假绿 · R10 自证窗口下限；豁免在执行输出里逐条列出。
下面五条靠人执行；违反任一条，本轮改动不算完成。

- **R1 验收只在 CI 四平台**：不跑整套测试当验收；不以本机绿灯为放行依据；不以本机红灯为由改代码。
- **R2 CI 等价复现**：定位与突变验证只用 `node test/_runner.js --only=<file>`（该文件须已登记）；它不是验收。
- **R4 测试突变验证**：新增或修改测试后，故意改坏被测点 ⇒ 必须红 ⇒ 还原；提交附「改前/改后 SHA256 相同」的证据。
- **R7 跨语言单源一致性**：必须比边界输入（空串、纯空白、缺值、超长、大小写）的行为，不只比常量与名字集合。
- **R8 单一事实源单写者**：`core/test/manifest.js`、`core/package.json#version`、`core/src/shared/brand.js` 与
  `shell/src-tauri/src/brand.rs` 只由单写者改；代理不得代改，要改就提出登记请求（file/tier/os/why）。
