'use strict';

// 「是否值得为插件变更重启」= 存活判据（身份匹配），不是「端口上有没有人」（H-02）。
// 端口上蹲着外来进程时重启毫无意义（我们拉起的实例根本不在这）⇒ 必须按 running 判，不能按 portTaken 判。
function targetRunning(ctx, target) {
  if (!ctx.instances || !target) return false;
  try {
    const probeId = target.id === 'native' ? 'main' : target.id;
    return !!(ctx.instances.probeInstance(probeId) || {}).running;
  } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function applyPluginChange(ctx, target, kind, onLog) {
  const log = (m) => { try { if (typeof onLog === 'function') onLog(m); } catch {} };
  if (!target) return false;
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
