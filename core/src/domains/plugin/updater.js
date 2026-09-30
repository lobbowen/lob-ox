'use strict';

// 插件域更新检测与执行（网络 + CLI 编排）。
// 查 registry 最高版 vs 已装版；npm 型走 update，失败退 add；git/local 型拒绝。
// 检测状态（逐插件缓存 _updCache/_updTTL + 快照 _updSnapshot/_updInFlight）挂在装配根，经 ctx 显式访问。

const { specType, isUpdateAvailable } = require('./policies');

/** 目标版本 + 取不到时的原因（checkUpdates/update 共用一处，两处的负缓存口径必须一致）。
 *  只在取到时写缓存：把「registry 不可达」写进去，等于负缓存 _updTTL 之久、此后一律显示「无更新」。
 *  选版单源在 dist.fetchNpmLatest（latest 优先，缺失/非法才回落 versions 最高；取 registry 全量
 *  最高会把他人杂 tag 当候选），本层不再判通道。 */
async function latestCached(ctx, name, force) {
  const c = ctx._updCache[name];
  if (c && !force && (Date.now() - c.at) < ctx._updTTL) return { latest: c.latest, error: null };
  let latest = null;
  let error = '分发服务不可用';
  if (ctx.dist) {
    try {
      const r = await ctx.dist.fetchNpmLatest(name);
      latest = r && r.ok ? r.version : null;
      error = r && r.ok ? null : ((r && r.error) || '未取到版本');
    } catch (e) { error = (e && e.message) || String(e); }
  }
  if (latest !== null) ctx._updCache[name] = { latest, at: Date.now() };
  return { latest, error };
}

/** 检测快照：立即返回已知结论，registry 往返一律在后台跑（与 /plugins/market 同一口径）。
 *  挂在 HTTP 请求上等 N 个插件的往返，等于让面板 15s 计时先放弃而服务端继续跑 —— 用户见失败、结论却是好的。
 *  失败不做静默重试：快照里的 error 逐插件带上原因，面板据此区分「取不到」与「已是最新」。 */
function checkUpdates(ctx, force) {
  if (!ctx._updSnapshot || force) _requestCheck(ctx, force);
  const s = ctx._updSnapshot;
  return Promise.resolve({
    ok: true,
    checkedAt: s ? s.checkedAt : 0,
    plugins: s ? s.plugins : [],
    refreshing: !!ctx._updInFlight,
    error: s ? s.error : null,
  });
}

/** 触发一次后台检测；已有在飞即复用（force 连点不叠加）。 */
function _requestCheck(ctx, force) {
  if (ctx._updInFlight) return ctx._updInFlight;
  const raw = refreshUpdates(ctx, force);
  raw.catch(() => {}); // 无消费者 await：不标记则一次意外就是进程级 unhandledRejection
  ctx._updInFlight = raw;
  raw.catch((e) => {
    const msg = (e && e.message) || String(e);
    if (ctx.logger && ctx.logger.warn) ctx.logger.warn('plugin check-updates 失败: ' + msg);
    if (!ctx._updSnapshot) ctx._updSnapshot = { checkedAt: 0, plugins: [], error: msg };
  }).then(() => { if (ctx._updInFlight === raw) ctx._updInFlight = null; });
  return raw;
}

/** 一次完整检测：逐插件查 registry 最高版（有界并发）并聚合逐目标行。 */
async function refreshUpdates(ctx, force) {
  const targets = [ctx._nativeTarget(), ...ctx._allSandboxTargets()];
  const meta = new Map();
  for (const t of targets) {
    for (const p of ctx.installedOn(t)) {
      if (meta.has(p.name)) continue;
      meta.set(p.name, { specType: specType(p.source), latest: null, error: null });
    }
  }
  // 串行会把每个插件的往返时间相加（registry 慢时各吃满传输超时），故 6 并发分批。
  const npmNames = [...meta.entries()].filter(([, m]) => m.specType === 'npm' && ctx.dist).map(([name]) => name);
  const errors = [];
  for (let i = 0; i < npmNames.length; i += 6) {
    const slice = npmNames.slice(i, i + 6);
    await Promise.all(slice.map(async (name) => {
      const r = await latestCached(ctx, name, force);
      const m = meta.get(name);
      m.latest = r.latest;
      m.error = r.error;
      if (r.error) errors.push(name + ': ' + r.error);
    }));
  }
  const rows = [];
  for (const t of targets) {
    for (const p of ctx.installedOn(t)) {
      const m = meta.get(p.name) || { specType: 'npm', latest: null, error: null };
      const updateAvailable = m.specType === 'npm' && isUpdateAvailable(m.latest, p.version);
      rows.push({ name: p.name, target: t.id, targetName: t.name, installed: p.version || null, latest: m.latest || null, updateAvailable, specType: m.specType, bundle: p.bundle });
    }
  }
  const byName = new Map();
  for (const row of rows) {
    let rec = byName.get(row.name);
    if (!rec) { byName.set(row.name, { name: row.name, specType: row.specType, error: meta.get(row.name) ? meta.get(row.name).error : null, targets: [] }); rec = byName.get(row.name); }
    rec.targets.push({ id: row.target, name: row.targetName, installed: row.installed, latest: row.latest, updateAvailable: row.updateAvailable });
  }
  const plugins = [...byName.values()]
    .map((x) => ({ name: x.name, specType: x.specType, error: x.error, updateAvailable: x.targets.some((t) => t.updateAvailable), targets: x.targets }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const snap = { checkedAt: Date.now(), plugins, error: errors.length ? errors.join('; ') : null };
  ctx._updSnapshot = snap;
  return snap;
}

/** 执行更新：逐目标串行（npm update，失败退 add）；成功后重启生效。 */
async function update(ctx, name, targetStr) {
  if (!name) return { ok: false, error: 'missing plugin name' };
  const r = ctx.resolveTargets(targetStr);
  if (!r.ok) return r;
  const targets = r.targets.filter((t) => ctx.installedOn(t).some((p) => p.name === name));
  if (!targets.length) { const desc = targetStr === 'all' ? '任何目标' : ('目标「' + (targetStr || 'native') + '」'); return { ok: false, error: desc + ' 未安装插件 ' + name }; }
  const pick = await latestCached(ctx, name, false);
  const latest = pick.latest;
  if (!latest) return { ok: false, error: '无法获取 ' + name + ' 的最新版本（' + (pick.error || 'registry 不可达') + '），请检查网络后重试' };
  const job = ctx.jobs.createJob('update', name, targetStr || 'native', targets);
  if (ctx.events) ctx.events.append('plugin_update_started', { name, jobId: job.id, target: job.target, targets: targets.map((t) => t.name) });
  let idx = 0;
  const next = () => {
    if (idx >= job.targets.length) {
      const failed = job.targets.filter((t) => t.state === 'failed');
      const ok = failed.length === 0;
      ctx.jobs.finishJob(job, ok, ok ? null : ((failed[0] && failed[0].error) || '部分目标失败'));
      if (ctx.events) {
        if (ok) ctx.events.append('plugin_update_done', { name, jobId: job.id });
        else ctx.events.append('plugin_update_job_failed', { name, jobId: job.id, error: (failed[0] && failed[0].error) || '部分目标失败' });
      }
      return;
    }
    const target = targets[idx], jt = job.targets[idx];
    jt.state = 'running';
    ctx.jobs.withScopeLock(target.id, async () => {
      let res;
      const installed = ctx.installedOn(target).find((x) => x.name === name);
      const st = installed ? specType(installed.source) : 'npm';
      if (st !== 'npm') {
        res = { ok: false, error: '本地/git 型插件不支持 registry 更新（spec: ' + (installed && installed.source) + '）' };
      } else if (!installed || !isUpdateAvailable(latest, installed.version)) {
        res = { ok: true, skipped: true, error: null };
        jt.log.push('已是最新版本（' + (installed && installed.version || '?') + '）');
      } else {
        res = await ctx._runCli(target, ['update', name + '@' + latest], { onLine: (l) => { jt.log.push(l); if (jt.log.length > 30) jt.log.shift(); } });
        if (!res.ok) {
          const addRes = await ctx._runCli(target, ['add', name + '@' + latest], { onLine: (l) => { jt.log.push(l); if (jt.log.length > 30) jt.log.shift(); } });
          if (addRes.ok) { res = { ok: true, error: null }; jt.log.push('已通过 add 确立依赖并更新'); }
        }
      }
      jt.state = res.ok ? 'done' : 'failed';
      jt.error = res.ok ? null : (res.error || '');
      if (!(res && res.skipped)) jt.log.push(res.ok ? '完成' : ('失败: ' + (res.error || '')));
      if (ctx.events) ctx.events.append(res.ok ? 'plugin_update_ok' : 'plugin_update_failed', { name, target: target.name, jobId: job.id, error: res.error });
      if (res.ok && !res.skipped) await ctx._applyPluginChange(target, 'update', (m) => jt.log.push(m));
    }).then(() => { idx++; next(); });
  };
  next();
  return { ok: true, jobId: job.id, target: job.target };
}

module.exports = { checkUpdates, update };
