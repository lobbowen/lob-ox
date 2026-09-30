#!/usr/bin/env node
'use strict';

// 把一个平台矩阵 job 的「安装包 + .sig」组装为可发布 npm 包，并产出汇总阶段生成清单的中间文件。
// Tauri 的 {{target}}/{{arch}} 取值（linux|windows|darwin / x86_64|aarch64）与 npm 包命名
// （linux|win|darwin / x64|arm64）不同，直接拼进包名会得到不存在的包，故清单内部用 OS-ARCH 键
// 映射到真实 npm 产物 URL。--require-sig 时缺 .sig 即失败（发布路径）；不带则只报告不失败。

const fs = require('node:fs');
const path = require('node:path');

// npm 包后缀 -> Tauri 清单键（OS-ARCH）+ 运行时安装形态
const PLATFORMS = {
  'linux-x64':    { os: 'linux',  cpu: 'x64',   manifestKey: 'linux-x86_64',   installer: 'deb'  },
  'linux-arm64':  { os: 'linux',  cpu: 'arm64', manifestKey: 'linux-aarch64',  installer: 'deb'  },
  'darwin-x64':   { os: 'darwin', cpu: 'x64',   manifestKey: 'darwin-x86_64',  installer: 'app'  },
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', manifestKey: 'darwin-aarch64', installer: 'app'  },
  'win-x64':      { os: 'win32',  cpu: 'x64',   manifestKey: 'windows-x86_64', installer: 'nsis' },
  'win-arm64':    { os: 'win32',  cpu: 'arm64', manifestKey: 'windows-aarch64',installer: 'nsis' },
};

const ARTIFACT_PATTERNS = {
  deb:  [/\.deb$/],
  app:  [/\.app\.tar\.gz$/],
  nsis: [/-setup\.exe$/i, /\.exe$/i],
};

// 关闭 updater 产物的构建（无密钥的验证构建）不会产 .app.tar.gz，只产 .dmg。
// 主形态命中时永不走这里，故 tag 发布的产物集合与既往完全一致。
const FALLBACK_PATTERNS = {
  app: [/\.dmg$/],
};

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const nxt = argv[i + 1];
    // 布尔开关不能吞掉后一个 token 当值：否则末尾的 --require-sig 会得到 undefined，
    // 且它前面的真值参数会被整体错位一格。
    if (nxt === undefined || nxt.startsWith('--')) { o[k] = true; continue; }
    o[k] = nxt;
    i += 1;
  }
  return o;
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

function findArtifacts(bundleDir, installer, version) {
  const all = walk(bundleDir).filter((f) => !/\.sig$/.test(f));
  const by = (pats) => all.filter((f) => pats.some((re) => re.test(path.basename(f))));
  let hits = by(ARTIFACT_PATTERNS[installer] || []);
  if (!hits.length && FALLBACK_PATTERNS[installer]) {
    hits = by(FALLBACK_PATTERNS[installer]);
    if (hits.length) console.log('   主形态未命中，改用备用形态（关闭 updater 产物的验证构建）');
  }
  // 必须按版本过滤：bundle 目录会累积历史版本安装包，
  //   不过滤会把旧版本一并打进发布包（体积膨胀 + 语义混乱，且清单与包内容不一致）。
  //   CI 每次全新 workspace 故只产一个版本，但本地开发/重跑会命中此问题（实测 1.0.1 与 1.0.2 同目录）。
  const versionHits = version ? hits.filter((f) => path.basename(f).includes(version)) : hits;
  const picked = versionHits.length ? versionHits : hits;
  if (version && versionHits.length && versionHits.length < hits.length) {
    console.log('   已按版本过滤：' + versionHits.length + '/' + hits.length + ' 个产物匹配 ' + version);
  }
  const withSig = picked.filter((f) => fs.existsSync(f + '.sig'));
  return (withSig.length ? withSig : picked).map((f) => ({ file: f, sig: f + '.sig' }));
}

function main() {
  const a = parseArgs(process.argv);
  const plat = a.platform;
  const ver = a.ver;
  const bundleDir = a['bundle-dir'];
  const out = a.out || 'dist/npm-shell';
  const meta = PLATFORMS[plat];
  if (!meta) { console.error('未知平台: ' + plat + '（可用: ' + Object.keys(PLATFORMS).join(', ') + '）'); process.exit(2); }
  if (!ver) { console.error('缺少 --ver'); process.exit(2); }
  if (!bundleDir) { console.error('缺少 --bundle-dir'); process.exit(2); }

  const pkgName = '@dsh-sup/shell-' + plat;
  const stage = path.join(out, pkgName);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'artifact'), { recursive: true });

  const arts = findArtifacts(bundleDir, meta.installer, ver);
  if (!arts.length) { console.error('未在 ' + bundleDir + ' 找到 ' + meta.installer + ' 产物'); process.exit(1); }

  const entries = [];
  for (const it of arts) {
    const dst = path.join(stage, 'artifact', path.basename(it.file));
    fs.copyFileSync(it.file, dst);
    let sigText = null;
    if (fs.existsSync(it.sig)) {
      sigText = fs.readFileSync(it.sig, 'utf8').trim();
      fs.copyFileSync(it.sig, dst + '.sig');
    }
    entries.push({ name: path.basename(it.file), sig: sigText });
  }

  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
    name: pkgName, version: ver,
    description: 'DSH supervisor desktop shell updater artifact for ' + plat + ' (Tauri updater).',
    license: 'MIT', os: [meta.os], cpu: [meta.cpu], files: ['artifact'],
  }, null, 2) + '\n');

  fs.writeFileSync(path.join(stage, 'artifact', 'manifest-entry.json'), JSON.stringify({
    platform: plat, manifestKey: meta.manifestKey, version: ver, installer: meta.installer, entries,
  }, null, 2) + '\n');

  console.log('== 组装完成: ' + stage + ' ==');
  console.log('   包名: ' + pkgName + '@' + ver);
  console.log('   清单键: ' + meta.manifestKey);
  for (const e of entries) console.log('   产物: ' + e.name + (e.sig ? ' (+sig)' : ' (无 sig!)'));

  const missing = entries.filter((e) => !e.sig);
  if (missing.length) {
    const names = missing.map((e) => e.name).join(', ');
    if (a['require-sig'] === true) {
      console.error('有产物缺 .sig —— 自动更新不可用（请确认 TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) 已配置）: ' + names);
      process.exit(1);
    }
    console.log('未签名构建（缺 .sig）: ' + names + ' —— 仅供产线验证，不可发布自动更新');
  }
}

main();
