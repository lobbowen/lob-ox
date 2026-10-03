#!/usr/bin/env node
'use strict';


const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : '')); };

const PL = path.join(ROOT, 'src', 'platform', 'os', 'index.js');
const TG = path.join(ROOT, 'src', 'domains', 'plugin', 'targets.js');
const SB = path.join(ROOT, 'src', 'domains', 'instance', 'sandbox.js');

function withPlatform(isWin, fn) {
  const realIsWindows = isWin ? true : false;
  let saved = null;
  try { saved = require.cache[PL]; } catch {}
  const plat = require(PL);
  const orig = Object.getOwnPropertyDescriptor(plat, 'isWindows');
  Object.defineProperty(plat, 'isWindows', { get: () => realIsWindows, configurable: true });
  try { return fn(); } finally {
    if (orig) Object.defineProperty(plat, 'isWindows', orig); else delete plat.isWindows;
    if (saved) require.cache[PL] = saved;
  }
}

function mkCtx(installRoot) {
  const inst = { id: 'sb1', name: '沙箱', domain: 'sandbox' };
  const rootDir = path.join(installRoot, 'sb1');
  return {
    inst,
    ctx: {
      dshBin: 'C:/x/dsh/lib/bin.js', profileDir: 'C:/x/p', profileName: 'default',
      instances: {
        all: () => [inst], find: (id) => (id === 'sb1' ? inst : null),
        sandboxDataDir: (i) => path.join(rootDir, 'data'),
        sandboxInstallDir: (i) => path.join(rootDir, 'install'),
        sandboxRoot: (i) => rootDir,
      },
    },
  };
}

// G-1/G-2：win32 下 bin/NODE_PATH 必须走 <install>/node_modules（此前硬编 lib/node_modules ⇒ 目标静默消失）
withPlatform(true, () => {
  delete require.cache[TG]; delete require.cache[SB];
  const targets = require(TG);
  const { ctx, inst } = mkCtx(os.tmpdir());
  const t = targets.sandboxTarget(ctx, inst);
  check('G-1 win32 沙箱 bin 落在 <install>/node_modules（不再硬编 lib/node_modules）',
    !!t && !String(t.bin).includes(path.join('lib', 'node_modules')) && String(t.bin).includes('node_modules'), t && t.bin);
  check('G-2 win32 NODE_PATH 同步走 nodeModulesDir 单源',
    !!t && String(t.env.NODE_PATH).endsWith(path.join('node_modules')), t && t.env.NODE_PATH);
});

// G-3：POSIX 行为不得变（回归保护）
withPlatform(false, () => {
  delete require.cache[TG]; delete require.cache[SB];
  const targets = require(TG);
  const { ctx, inst } = mkCtx(os.tmpdir());
  const t = targets.sandboxTarget(ctx, inst);
  check('G-3 POSIX 仍为 <install>/lib/node_modules（既有行为不变）',
    !!t && String(t.bin).includes(path.join('lib', 'node_modules')), t && t.bin);
});

// G-4：win32 下目标真实存在时 resolveTargets 必须 ok:true（此前因布局错误被静默过滤）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lobox-w0c-'));
const { ctx, inst } = mkCtx(tmp);
const rootDir = path.join(tmp, 'sb1');
const binRel = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
fs.mkdirSync(path.dirname(path.join(rootDir, 'install', binRel)), { recursive: true });
fs.writeFileSync(path.join(rootDir, 'install', binRel), '');
withPlatform(true, () => {
  delete require.cache[TG]; delete require.cache[SB];
  const targets = require(TG);
  const r = targets.resolveTargets(ctx, 'sb1');
  check('G-4 win32 布局正确时 resolveTargets 命中（不再误报"未安装 DeepSeek Harness"）',
    r && r.ok === true, JSON.stringify(r && r.error));
});

process.exit(results.every(Boolean) ? 0 : 1);
