#!/usr/bin/env bash
# 平台清单单源 = package.json#npmPublish.packages；不得在脚本/workflow 另存硬编码矩阵。
# 输出每行 <osTag> <plat> <arch>（不含包名）：osTag=linux|darwin|win，plat=process.platform（win→win32），arch=x64|arm64。

dsh_platform_matrix() {
  node -e '
  const p = require("./package.json");
  const list = (p.npmPublish && p.npmPublish.packages) || [];
  /* 固定顺序：与历史发布顺序一致，便于 diff 与人工核对 */
  const ORDER = ["linux-x64", "darwin-arm64", "darwin-x64", "win-x64"];
  const parsed = [];
  for (const name of list) {
    const m = /^core-(linux|darwin|win)-(x64|arm64)$/.exec(String(name));
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

dsh_platform_matrix_assert() {
  local m
  m="$(dsh_platform_matrix)"
  [ -n "$m" ] || { echo "❌ 平台矩阵为空（检查 package.json#npmPublish.packages）" >&2; return 1; }
  local n
  n="$(printf "%s\n" "$m" | grep -c .)"
  [ "$n" -eq 4 ] || { echo "❌ 平台矩阵应为 4 条，实为 $n 条：$m" >&2; return 1; }
  printf "%s\n" "$m"
}
