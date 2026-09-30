'use strict';

// 插件域变更生效（IO）：对已变更且运行中的目标触发重启，沙箱走 instances 停起重试，
// 原生走 onNativeRestart。能力经 ctx 显式传入，不读 this。

/** 目标是否运行中（native -> main 探针；其它 -> 自身 id）。 */
function targetRunning(ctx, target) {
  if (!ctx.instances || !target) return false;
  try {
    const probeId = target.id === 'native' ? 'main' : target.id;
    return !!(ctx.instances.probeInstance(probeId) || {}).running;
  } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 插件变更后使运行中的目标生效（沙箱停起 / 原生回调）。 */
async function applyPluginChange(ctx, target, kind, onLog) {
  const log = (m) => { try { if (typeof onLog === 'function') onLog(m); } catch {} };
  if (!target) return false;
  // 本域注入的是裸 InstanceManager，INV-S1 退出门只在外层适配器（control/instance-adapter.js），
  //   故退出中 in-flight 的卸载/更新作业仍可直接停起实例。这里自查注入谓词（E-3 单源）：
  //   退出中即跳过重启并视为未生效（下次启动自然生效）。
  try {
    if (typeof ctx.exitIntended === 'function' && ctx.exitIntended()) {
      log('会话退出中：跳过插件变更生效重启（将在下次启动时生效）');
      return false;
    }
  } catch {}
  try {
    if (target.kind === 'sandbox') {
      if (!ctx.instances) { log('实例管理不可用，跳过重启'); return false; }
      if (!targetRunning(ctx, target)) { log('实例未运行：插件变更将在下次启动时生效'); return false; }
      log('重启实例「' + (target.name || target.id) + '」使插件变更生效…');
      if (ctx.events) ctx.events.append('plugin_restart_started', { name: target.name || target.id, target: target.id, kind });
      try { ctx.instances.stopInstance(target.id); } catch (e) { log('停止实例失败: ' + e.message); }
      // start 带重试：systemd stop 后端口释放通常瞬发，偶发占用则重试
      let res = null;
      for (let i = 0; i < 6; i++) {
        try { res = await ctx.instances.startInstance(target.id); } catch (e) { res = { ok: false, error: e.message }; }
        if (res && (res.ok || res.installing)) break;
        await sleep(1000);
      }
      if (!res || (!res.ok && !res.installing)) {
        log('实例重启失败：' + ((res && res.error) || '未知错误'));
        if (ctx.events) ctx.events.append('plugin_restart_failed', { name: target.name || target.id, target: target.id, kind, error: (res && res.error) || '' });
        return false;
      }
      log('实例「' + (target.name || target.id) + '」已重启，插件变更生效');
      if (ctx.events) ctx.events.append('plugin_restart_done', { name: target.name || target.id, target: target.id, kind });
      return true;
    }
    if (target.kind === 'native') {
      if (!targetRunning(ctx, target)) { log('原生 DSH 未运行：插件变更将在下次启动时生效'); return false; }
      if (typeof ctx.onNativeRestart === 'function') {
        let rr;
        try { rr = ctx.onNativeRestart(); } catch (e) { log('原生 DSH 重启请求失败: ' + e.message); return false; }
        if (rr && rr.ok === false) { log('原生 DSH 重启请求未生效：' + ((rr && rr.error) || 'unknown')); return false; }
        log('已请求重启原生 DSH 使插件变更生效');
        if (ctx.events) ctx.events.append('plugin_restart_done', { name: '原生实例', target: 'native', kind, via: 'supervisor' });
        return true;
      }
      log('提示：原生 DSH 需重启后插件变更生效（当前未配置自动重启）');
      return false;
    }
    return false;
  } catch (e) {
    log('插件变更生效处理失败: ' + e.message);
    return false;
  }
}

module.exports = { targetRunning, applyPluginChange };
