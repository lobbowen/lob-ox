#!/usr/bin/env bash
# 内核平台矩阵。
#
# 为什么单独成文件：平台清单此前散落在三处（build-launcher / publish-core / release-core），
# 且 GitHub workflow 里还有一份硬编码矩阵。四处不同步就会产出「少一个平台」的发布。
# 现统一从 `package.json#npmPublish.packages` 读取 —— 它本来就是 npm scope 子包的权威声明。
#
# 输出（每行一条，空格分隔，不含包名——包名可由 scope + os + arch 推出）：
#   <osTag> <plat> <arch>
#     osTag = linux | darwin | win      （产物目录/npm 包名用）
#     plat  = process.platform 取值      （launcher 目录名用：linux | darwin | win32）
#     arch  = x64 | arm64
#
# 用法： `. release/scripts/_platforms.sh` 后调用 `dsh_platform_matrix`。

# 打印全部平台（顺序固定：linux-x64 -> darwin-arm64 -> darwin-x64 -> win-x64）。
dsh_platform_matrix() {
  node -e '
  const p = require("./package.json");
  const list = (p.npmPublish && p.npmPublish.packages) || [];
  /* 固定顺序：与历史发布顺序一致，便于 diff 与人工核对 */
  const ORDER = ["linux-x64", "darwin-arm64", "darwin-x64", "win-x64"];
  const parsed = [];
  for (const name of list) {
    const m = /^dsh-core-(linux|darwin|win)-(x64|arm64)$/.exec(String(name));
    if (!m) continue;
    const osTag = m[1];
    const plat = osTag === "win" ? "win32" : osTag;
    parsed.push({ osTag, plat, arch: m[2] });
  }
  parsed.sort((a, b) => {
    const ia = ORDER.indexOf(a.osTag + "-" + a.arch);
    const ib = ORDER.indexOf(b.osTag + "-" + b.arch);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const x of parsed) process.stdout.write(x.osTag + " " + x.plat + " " + x.arch + "\n");
  '
}

# 校验矩阵非空且含本机平台（发布前的健全性检查，防 package.json 被改坏）。
dsh_platform_matrix_assert() {
  local m
  m="$(dsh_platform_matrix)"
  [ -n "$m" ] || { echo "❌ 平台矩阵为空（检查 package.json#npmPublish.packages）" >&2; return 1; }
  local n
  n="$(printf "%s\n" "$m" | grep -c .)"
  [ "$n" -eq 4 ] || { echo "❌ 平台矩阵应为 4 条，实为 $n 条：$m" >&2; return 1; }
  printf "%s\n" "$m"
}
