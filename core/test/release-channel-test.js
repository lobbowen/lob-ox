#!/usr/bin/env node
'use strict';


const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const dist = require(path.join(ROOT, 'src', 'platform', 'distribution', 'index.js'));
const channel = dist;
const { VERSION_RE } = dist;

const OPTS_MINE = { isOurs: true, isValid: (v) => VERSION_RE.test(v) };
const OPTS_THIRD = { isOurs: false, isValid: (v) => VERSION_RE.test(v) };
const meta = (tags, versions) => ({ 'dist-tags': tags, versions: versions || {} });
const obj = (arr) => arr.reduce((m, v) => { m[v] = {}; return m; }, {});

{
  check('归属 我们的内核/壳发布包 → isOurReleasePackage', channel.isOurReleasePackage('@dsh-sup/dsh-core-linux-x64') === true && channel.isOurReleasePackage('@dsh-sup/shell-release') === true);
  check('归属 第三方 DSH 本体/代理包 → 非我们的', channel.isOurReleasePackage('@deepseek-ai/dsh') === false && channel.isOurReleasePackage('commandcode-api-proxy') === false);
}

{
  const FLOORV = dist.ROLLBACK_FLOOR_VERSION;
  const m = meta({ rollback: FLOORV, canary: '0.1.6-BETA.1', latest: '0.1.4' }, obj(['0.1.4', FLOORV, '0.1.6-BETA.1']));
  check('① rollback 存在 → 返回它（即使同时有 canary+latest）',
    channel.pickReleaseVersion(m, { ...OPTS_MINE, canary: true }) === FLOORV);
  check('rollback 与 max 无关（可低于 versions 最高，但须过防降级下限）',
    channel.pickReleaseVersion(meta({ rollback: FLOORV, latest: '9.9.9' }, obj([FLOORV, '9.9.9'])), OPTS_MINE) === FLOORV);
}

{
  const attack = meta({ rollback: '0.1.0', latest: '0.2.0' }, obj(['0.1.0', '0.2.0']));
  check('低于下限的 rollback → 忽略，回落 latest（不降级）',
    channel.pickReleaseVersion(attack, OPTS_MINE) === '0.2.0');
  check('边界：rollback == 注入下限 → 采纳（且下限未被绕过）',
    channel.pickReleaseVersion(meta({ rollback: '0.3.0', latest: '0.4.0' }, obj(['0.3.0', '0.4.0'])),
      { ...OPTS_MINE, rollbackFloor: '0.3.0' }) === '0.3.0'
    && channel.pickReleaseVersion(meta({ rollback: '0.2.0', latest: '0.2.1' }, obj(['0.2.0', '0.2.1'])),
      { ...OPTS_MINE, rollbackFloor: '0.3.0' }) === '0.2.1');
  const NOW = Date.UTC(2026, 8, 19);
  const withTime = (daysAgo) => ({
    ...meta({ rollback: '0.2.0', latest: '0.3.0' }, obj(['0.2.0', '0.3.0'])),
    time: { '0.2.0': new Date(NOW - daysAgo * 86400000).toISOString() },
  });
  check('时效窗口：180 天前 → 忽略 rollback；7 天前 → 采纳；镜像剥掉 time → 仅下限守',
    channel.pickReleaseVersion(withTime(180), { ...OPTS_MINE, rollbackFloor: '0.1.0', now: NOW }) === '0.3.0'
    && channel.pickReleaseVersion(withTime(7), { ...OPTS_MINE, rollbackFloor: '0.1.0', now: NOW }) === '0.2.0'
    && channel.pickReleaseVersion(meta({ rollback: '0.2.0', latest: '0.3.0' }, obj(['0.2.0', '0.3.0'])),
      { ...OPTS_MINE, rollbackFloor: '0.1.0', now: NOW }) === '0.2.0');
  check('第三方包不套 rollback/下限语义（第三方包规则不受影响）',
    channel.pickReleaseVersion(meta({ rollback: '0.9.0', latest: '1.0.0' }, obj(['0.9.0', '1.0.0'])), OPTS_THIRD) === '1.0.0');
}

{
  const m = meta({ canary: '0.1.6-BETA.1', latest: '0.1.4' }, obj(['0.1.4', '0.1.6-BETA.1']));
  check('② 名单内 + canary 合法 → 返回 canary',
    channel.pickReleaseVersion(m, { ...OPTS_MINE, canary: true }) === '0.1.6-BETA.1');
  check('名单外 → 忽略 canary，取 latest',
    channel.pickReleaseVersion(m, { ...OPTS_MINE, canary: false }) === '0.1.4');
  check('② canary 非法（脏 tag）→ 跳过，取 latest',
    channel.pickReleaseVersion(meta({ canary: 'not-a-version', latest: '0.1.4' }, {}), { ...OPTS_MINE, canary: true }) === '0.1.4');
}

{
  const m = meta({ latest: '0.1.4' }, obj(['0.1.4', '0.1.5-BETA.7', '0.1.6-BETA.1']));
  check('③ latest 存在 → 返回它（不取全量最高）', channel.pickReleaseVersion(m, OPTS_MINE) === '0.1.4');
  check('③ latest 为合法预发布号也可用',
    channel.pickReleaseVersion(meta({ latest: '0.2.0-RC.1' }, obj(['0.2.0-RC.1'])), OPTS_MINE) === '0.2.0-RC.1');
}

{
  const m142 = meta({}, obj(['0.1.3', '0.1.5-BETA.7', '0.1.4']));
  check('④ latest 缺失 → versions 最高，但**不越过 BETA**（发布条 4 改判）',
    channel.pickReleaseVersion(m142, OPTS_MINE) === '0.1.4',
    channel.pickReleaseVersion(m142, OPTS_MINE));
  check('④ latest 非法 → versions 最高（无 BETA 时候选不变）',
    channel.pickReleaseVersion(meta({ latest: 'garbage' }, obj(['0.1.3', '0.1.4'])), OPTS_MINE) === '0.1.4');
  check('④ 兜底只认 versions（不含 dist-tags 中的低值）',
    channel.pickReleaseVersion(meta({ bad: '0.9.9' }, obj(['0.1.1', '0.1.2'])), OPTS_MINE) === '0.1.2');
  check('③ latest 显式指向 BETA 仍采纳（tag 值是声明，排除只作用于兜底）',
    channel.pickReleaseVersion(meta({ latest: '0.1.5-BETA.7' }, obj(['0.1.5-BETA.7', '0.1.4'])), OPTS_MINE) === '0.1.5-BETA.7',
    channel.pickReleaseVersion(meta({ latest: '0.1.5-BETA.7' }, obj(['0.1.5-BETA.7', '0.1.4'])), OPTS_MINE));
  // 正式版形态是 -RC.n（同为 semver prerelease）⇒ 排除只认 -BETA. 字面，不得按「含连字符」判。
  check('④ 排除只认 -BETA. 形态：-RC.n 是我们的正式版，不得一并排除',
    channel.pickReleaseVersion(meta({}, obj(['0.1.5-BETA.9', '0.1.5-RC.1'])), OPTS_MINE) === '0.1.5-RC.1',
    channel.pickReleaseVersion(meta({}, obj(['0.1.5-BETA.9', '0.1.5-RC.1'])), OPTS_MINE));
  check('④ 第三方包不套 BETA 排除（对照：latest 缺失仍取 versions 最高）',
    channel.pickReleaseVersion(meta({}, obj(['1.0.0', '1.1.0-beta.2'])), OPTS_THIRD) === '1.1.0-beta.2',
    channel.pickReleaseVersion(meta({}, obj(['1.0.0', '1.1.0-beta.2'])), OPTS_THIRD));
}

{
  check('⑤ 空元数据 / 缺 meta / latest 非法且 versions 空 → null', channel.pickReleaseVersion(meta({}, {}), OPTS_MINE) === null && channel.pickReleaseVersion(null, OPTS_MINE) === null && channel.pickReleaseVersion(meta({ latest: 'garbage' }, {}), OPTS_MINE) === null);
  check('⑤ 全为非法版本 / versions 只有 BETA 且 latest 缺失 → null（宁可失败也不猜测试版）',
    channel.pickReleaseVersion(meta({ latest: 'x' }, obj(['1.0', 'v2'])), OPTS_MINE) === null
    && channel.pickReleaseVersion(meta({}, obj(['0.1.5-BETA.9', '0.1.5-BETA.10'])), OPTS_MINE) === null);
}

{
  const m = meta({ latest: '1.0.0', alpha: '1.2.0-alpha.1' }, obj(['1.0.0', '1.1.0', '1.2.0-alpha.1']));
  check('第三方包 latest 优先：他人杂 tag（alpha）与更高 versions 均不进候选（按 versions 最高会取 1.2.0-alpha.1）',
    channel.pickReleaseVersion(m, OPTS_THIRD) === '1.0.0'
    && channel.pickReleaseVersion(meta({ latest: '1.0.0' }, obj(['1.0.0', '1.1.0'])), OPTS_THIRD) === '1.0.0',
    channel.pickReleaseVersion(m, OPTS_THIRD));
  check('第三方包不套通道语义：带 rollback tag 或本机在灰度名单也不改变选版；latest 缺失才回落 versions 最高',
    channel.pickReleaseVersion(meta({ rollback: '0.9.0', latest: '1.0.0' }, obj(['0.9.0', '1.0.0', '1.1.0'])), OPTS_THIRD) === '1.0.0'
    && channel.pickReleaseVersion(meta({ canary: '2.0.0', latest: '1.0.0' }, obj(['1.0.0', '2.0.0'])), { ...OPTS_THIRD, canary: true }) === '1.0.0'
    && channel.pickReleaseVersion(meta({ alpha: '1.2.0-alpha.1' }, obj(['1.0.0', '1.1.0'])), OPTS_THIRD) === '1.1.0');
  check('仅 dist-tags 有 latest 也算候选；latest 非法且无 versions → null（绝不猜）',
    channel.pickReleaseVersion(meta({ latest: '3.0.0' }, {}), OPTS_THIRD) === '3.0.0'
    && channel.pickReleaseVersion(meta({ latest: 'x' }, {}), OPTS_THIRD) === null);
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
