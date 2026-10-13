const { sandboxEnv } = require('C:/work/lob-ox/core/src/domains/agent/runtime/sandbox-env.js');
const path = require('node:path');
const assert = require('node:assert');
let pass = 0; const fails = [];
function check(n, f) { try { f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); } }

const dirs = {
  data: path.join('var', 'agents', 'a1', 'data'),
  install: path.join('var', 'agents', 'a1', 'install'),
  nodeModules: path.join('var', 'agents', 'a1', 'install', 'lib', 'node_modules'),
  tmp: path.join('var', 'agents', 'a1', 'tmp'),
};
const r = sandboxEnv(dirs);

check('返回 env 与 workingDir', () => {
  assert.ok(r.env && typeof r.env === 'object');
  assert.strictEqual(r.workingDir, dirs.data);
});
check('HOME 与 USERPROFILE 同时设（Windows os.homedir 读后者）', () => {
  assert.strictEqual(r.env.HOME, dirs.data);
  assert.strictEqual(r.env.USERPROFILE, dirs.data);
});
check('XDG 四件套齐全', () => {
  assert.strictEqual(r.env.XDG_CONFIG_HOME, dirs.data);
  assert.strictEqual(r.env.XDG_DATA_HOME, dirs.data);
  assert.strictEqual(r.env.XDG_CACHE_HOME, path.join(dirs.data, 'cache'));
  assert.strictEqual(r.env.XDG_STATE_HOME, path.join(dirs.data, 'state'));
});
check('npm 缓存与配置钉在实例内', () => {
  assert.strictEqual(r.env.npm_config_cache, path.join(dirs.data, 'npm-cache'));
  assert.strictEqual(r.env.npm_config_userconfig, path.join(dirs.data, '.npmrc'));
  assert.strictEqual(r.env.npm_config_globalconfig, path.join(dirs.data, '.npmrc'));
});
check('TMPDIR 与 NODE_PATH', () => {
  assert.strictEqual(r.env.TMPDIR, dirs.tmp);
  assert.strictEqual(r.env.NODE_PATH, dirs.nodeModules);
});
check('缺 data 返回空 env（不假装隔离生效）', () => {
  const bad = sandboxEnv({});
  assert.deepStrictEqual(bad.env, {});
  assert.strictEqual(bad.workingDir, null);
});
check('Windows 专有变量（当前平台判定）', () => {
  const isWin = process.platform === 'win32';
  if (isWin) {
    assert.strictEqual(r.env.APPDATA, path.join(dirs.data, 'Roaming'));
    assert.strictEqual(r.env.LOCALAPPDATA, path.join(dirs.data, 'Local'));
    assert.ok(r.env.TMP && r.env.TEMP, 'Windows 须有 TMP/TEMP');
  } else {
    assert.strictEqual(r.env.APPDATA, undefined, '非 Windows 不设 APPDATA');
  }
});
console.log('agent sandbox-env 测试: ' + pass + ' 通过, ' + fails.length + ' 失败');
if (fails.length) { console.log(fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
console.log('ALL AGENT SANDBOX-ENV TESTS PASS');