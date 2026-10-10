# 本仓禁止新增测试 / 门禁 / 冒烟

唯一判据是 **CI 的构建结果**（`core.yml` 的 build、`shell.yml` 的 version+build）。
除构建本身外的一切"验证"——单元测试、回归测试、规范门禁（standards-check）、
发布后冒烟（published-smoke）、安装冒烟（install-smoke）——**一律禁止新增或恢复**。

## 为什么

1. **测试会制造错误认知**：测试通过不代表产品能跑，测试失败也不代表产品坏了。
   真实故障（如 `bootstrap.js` 缺分号）靠测试堆不出来，只有构建会如实报错。
2. **门禁会制造共同债务**：每一条门禁都要维护，且与真实产线漂移，
   最终变成"红灯常态化 → 无人看红灯"。
3. **只有构建是诚实的**：编译不过就是不过，构建失败就是失败。

## 硬性禁止清单

不得新增（含改名/换目录恢复）：

- `*-test.js` / `test/` / `tests/` 目录及其内容
- 测试 runner / manifest / 固件（`_runner.js`、`manifest.js`、`_preload.js` 等）
- 规范门禁脚本（`standards-check.js` 之类）
- 冒烟脚本（`*smoke*`、`install-smoke*`）
- CI 中任何 `cargo test` / `npm test` / `npm run test:*` 步骤
- 任何以"验证/断言/自检"为名、在构建之外重复判定产品行为的步骤

## 允许保留

- 构建本身的正确性保证：如 `build-launcher.sh` 的"四平台 core.cjs 逐字节相同"一致性断言
  （它是构建产物自检，不是产品行为测试）
- 发布产线：`build` / `publish` / `release`（tag 触发）

## 执行

`core.yml` 与 `shell.yml` 的 build job 含**禁令执行器** step：
检出后扫描工作区，命中上述任一禁止项即直接 fail。
想绕过它，必须先改本文件并取得明确同意——那等于推翻本仓的根本约定。
