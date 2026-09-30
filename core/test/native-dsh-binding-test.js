#!/usr/bin/env node
'use strict';

// 原生 DSH「检测 -> 绑定 -> 接管」契约回归。
// 缺陷（真机）：原生 DSH 只被静态 config.command[1]（出厂默认裸名 'dsh'）定义 ->
//   fs.existsSync('dsh') 恒 false -> 「已安装」判不出来，与「安装」分支形成两套相反逻辑
//   （系统已装 DSH 却报未安装 -> 面板去装第二个 DSH 顶替原生的那个）。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bind-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

const EMPTY_HOME = path.join(TMP, 'emptyhome');
fs.mkdirSync(EMPTY_HOME, { recursive: true });
const EMPTY_PREFIX = path.join(TMP, 'empty-prefix');
fs.mkdirSync(EMPTY_PREFIX, { recursive: true });

function fakePkg(prefix, version) {
  const js = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  return js;
}
const PREFIX = path.join(TMP, 'npm');
const JS = fakePkg(PREFIX, '9.9.9');

const ENV_KEYS = ['HOME', 'USERPROFILE', 'PATH', 'Path', 'APPDATA', 'LOCALAPPDATA', 'DSH_BIN'];
const saved = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
/** 隔离所有「可能命中真实 dsh」的环境来源，使负例确定。 */
function isolate() {
  process.env.HOME = EMPTY_HOME; process.env.USERPROFILE = EMPTY_HOME;
  process.env.PATH = ''; process.env.Path = '';
  process.env.APPDATA = path.join(EMPTY_HOME, 'appdata');
  process.env.LOCALAPPDATA = path.join(EMPTY_HOME, 'localappdata');
  delete process.env.DSH_BIN;
}
function restore() {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
}

const ep = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path'));
const { NativeManager } = require(path.join(ROOT, 'src', 'app', 'native', 'installer'));
// macOS 下 /tmp、/var 是符号链接（realpath 得到 /private/...）——比较前统一规范化，跨平台稳定。
const canon = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const mkNM = (command, npmRoot) => new NativeManager({
  config: { command, packageName: '@deepseek-ai/dsh' },
  npmRoot,
  stateDir: TMP,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
});

isolate();

// 1) resolveDsh：DSH_BIN 显式覆盖（最高优先级）
process.env.DSH_BIN = JS;
const d1 = ep.resolveDsh({});
check('resolveDsh(DSH_BIN) 返回真实 JS 入口', d1 && d1.isJs === true && canon(d1.bin) === canon(JS), d1 && d1.bin);

// 2) resolveDsh：npmRoot 分支（PATH 无 dsh、home 为空）
delete process.env.DSH_BIN;
const d2 = ep.resolveDsh({ npmRoot: PREFIX });
check('resolveDsh(npmRoot) 命中包内 lib/bin.js', d2 && canon(d2.bin) === canon(JS), d2 && d2.bin);

// 3) NativeManager：已绑定绝对入口 -> 已安装 + 版本可读
const bound = mkNM(['node', JS, 'web'], PREFIX);
check('已绑定入口 → installed=true', bound.status().installed === true, bound.binPath());
check('已绑定入口 → 读到真实版本', bound.installedVersion() === '9.9.9', String(bound.installedVersion()));

// 4) NativeManager：裸名 + 无任何可解析安装 -> 如实未安装（不再伪造）
const bare = mkNM(['node', 'dsh', 'web'], EMPTY_PREFIX);
check('裸名且无可解析安装 → installed=false（如实）', bare.status().installed === false, String(bare.binPath()));

// 5) 反向可判别：同一 config，注入真实安装后即判为已安装（检测驱动，非静态写死）
process.env.DSH_BIN = JS;
const adopted = mkNM(['node', 'dsh', 'web'], EMPTY_PREFIX);
check('检测到真实安装 → installed=true（检测驱动）', adopted.status().installed === true, adopted.binPath());

// 6/7/8) 已删：`typeof … === 'function'` 形状断言（改名即红而产品等价）、runtime-contract 的 npmArgs
//   逐字重复采样、以及安装成功路径的当场复跑。行为侧由 §1–§5 与 §9/§10 承担。

// 9) D-9：升级/重装不得用空数组抹掉 dataPaths 认领（Array.isArray([]) 为真 =>
//    传 [] 会把上一代认领写成 []，卸载清理恒 no-op，目录永久残留）。
{
  const mf = require(path.join(ROOT, 'src', 'app', 'native', 'manifest.js'));
  const mdir = path.join(TMP, 'd9-manifest');
  fs.mkdirSync(mdir, { recursive: true });
  const mfFile = path.join(mdir, 'native-manifest.json');
  const host = {
    manifestFile: mfFile, dshHome: path.join(mdir, 'dsh-home'), stateDir: mdir,
    logger: { info() {}, warn() {}, error() {} },
    config: { command: ['node', path.join(mdir, 'no-such-bin')], packageName: '@deepseek-ai/dsh' },
  };
  const readM = () => { try { return JSON.parse(fs.readFileSync(mfFile, 'utf8')); } catch { return null; } };
  // 认领路径取自夹具目录（宿主中性）：本仓 X-1 门禁禁止测试里钉死操作者的绝对路径。
  const CLAIM = [path.join(mdir, 'dsh-home', 'sessions')];

  mf.record(host, '1.0.0', CLAIM, '/npmroot');
  const m1 = readM();
  check('D-9 首装显式传认领被写入', !!m1 && JSON.stringify(m1.dataPaths) === JSON.stringify(CLAIM), JSON.stringify(m1 && m1.dataPaths));

  mf.record(host, '1.0.1', undefined, '/npmroot');
  const m2 = readM();
  check('D-9 升级（不传 dataPaths）继承上一代认领', !!m2 && JSON.stringify(m2.dataPaths) === JSON.stringify(CLAIM) && m2.version === '1.0.1', JSON.stringify(m2 && m2.dataPaths));

  mf.record(host, '1.0.4', ['/a', '/b'], '/npmroot');
  check('D-9 反向：非数组（null）才走继承而不覆盖',
    readM().dataPaths.length === 2, JSON.stringify(readM().dataPaths));

  // 已删两条「缺陷形态复现」（把已知缺陷固化为期望 = 负价值）。按第二条路断言**调用点行为**：
  //   升级/重装路径必须传 undefined 而非 []，见文件尾部 D-9 调用点判据。

  try { fs.rmSync(mdir, { recursive: true, force: true }); } catch {}
}

// D-10：主实例（原生 DSH）的启动命令必须自带 --no-open。
// `dsh web` 自己会拉起系统浏览器，这条路绕在 platform/os/browser#openBrowser 唯一出口之外：没有能力档、
// 没有预检、没有三档证据，守卫每重启一次就多弹一个窗。该闸要覆盖每一条组装口，不能只装在沙箱那条上。
{
  const { nativeCommand } = require(path.join(ROOT, 'src', 'app', 'native', 'command.js'));
  const dshCli = require(path.join(ROOT, 'src', 'platform', 'contract', 'dsh-cli.js'));
  const cmd = nativeCommand({ command: [process.execPath, JS, 'web'], targetPort: 3080 });
  check('D-10 主实例 web 命令在组装口补 --no-open，且端口注入不受影响',
    cmd.includes('--no-open') && String(cmd[cmd.indexOf('--port') + 1]) === '3080', JSON.stringify(cmd));
  const keepOpen = nativeCommand({ command: [process.execPath, JS, 'web', '--open'], targetPort: 3080 });
  const notWeb = nativeCommand({ command: [process.execPath, JS, '--version'] });
  check('D-10 反向：显式 --open 与非 web 形态均原样交回，不被改写',
    keepOpen.includes('--open') && !keepOpen.includes('--no-open')
    && notWeb.length === 3 && !notWeb.includes('--no-open'), JSON.stringify([keepOpen, notWeb]));
  const once = nativeCommand({ command: [process.execPath, JS, 'web', '--no-open'], targetPort: 3080 });
  const sep = dshCli.withoutAutoOpen([process.execPath, JS, 'web', '--', 'web']);
  check('D-10 已带 --no-open 不重复补；分隔符后的位置参数不当开关（补在分隔符前）',
    once.filter((t) => t === '--no-open').length === 1
    && sep.indexOf('--no-open') < sep.indexOf('--'), JSON.stringify([once, sep]));
}

restore();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

function finish() {
  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
}

// D-9（**调用点**行为）：升级/重装路径不得把 [] 交给 manifest.record —— 驱动真实安装入口
//   （依赖全部打桩），非首装时第二个实参必须是 undefined，且不得重新认领数据路径。
(async () => {
  const nm = mkNM(['node', JS, 'web'], PREFIX);
  let upgradeArg = 'NOT-CALLED';
  nm.checkEnvironment = async () => ({ ok: true });
  nm._selectRegistry = async () => 'fixture-registry';
  nm._runNpm = async () => ({ ok: true });
  nm._manifest = () => ({ version: '1.0.0', dataPaths: ['/already-claimed'] }); // 已有清单 => 非首装
  nm._claimDataPaths = () => { throw new Error('非首装不得重新认领数据路径'); };
  nm._recordManifest = async (v, dp) => { upgradeArg = dp; };
  nm.installedVersion = () => '1.0.1';
  let driveErr = null;
  try { await nm.install('1.0.1'); } catch (e) { driveErr = String((e && e.message) || e); }
  check('D-9 升级路径交给 manifest.record 的 dataPaths 是 undefined（不是 []；传 [] 会抹掉上一代认领）',
    !driveErr && upgradeArg === undefined, driveErr || JSON.stringify(upgradeArg));
})().then(finish, (e) => { check('D-9 驱动安装入口的夹具未抛错', false, String((e && e.stack) || e)); finish(); });