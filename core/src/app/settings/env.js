'use strict';

const platform = require('../../platform/os/index');

// 环境状态门面（壳写 runtime.json；EnvCatalog 声明式探测）。
// 导出形态 { methods }，方法经 this 协作。
const fs = require('node:fs');
const { EnvCatalog } = require('../../platform/service/env-catalog');
const runtimeContract = require('../../platform/contract/runtime');

async function envCatalogSummary(that) {
  const cat = new EnvCatalog(that.config);
  const extra = {};
  const d = that.dshenvStatus();
  extra.dsh = cat.dshEntry(d.binOk, d.installed, d.bin);
  extra.selfUpdate = cat.selfUpdateEntry();
  // 显式传 sys：复用本次异步探测，summary 不得回落同步 probe（冻结 + 重复探测）。
  return cat.summary(extra, await cat.probeAsync());
}

module.exports = {
  methods: {
    // 异步：全部子进程探测（EnvCatalog/契约回读）走异步口径——本方法挂在 /env/status 上，
    //   同步 execFileSync 会把守卫事件循环冻结在探测超时上（心跳/自愈停摆，B1-6 收口）。
    async envStatus() {
      // runtime 契约唯一读取口 = platform/contract/runtime；不得在此手写
      //   dirname(stateFile) + 'runtime.json'：与契约真实落点（<产品状态根>/supervisor）
      //   不必然同源，状态根一挪就静默读空。
      const c = runtimeContract.read() || {};
      const cat = await new EnvCatalog(this.config).probeAsync();
      const en = this.nativeManager && typeof this.nativeManager.checkEnvironment === 'function'
        ? await this.nativeManager.checkEnvironment() : null;
      return {
        node: { detected: cat.node.detail || null, runtime: c.nodeVersion || null, path: c.nodePath || null },
        // npm 与 node 同构三段：detected = 本机实跑版本；runtime = 壳实跑后投放的版本
        //   （null 表示壳未回读，不得拿 node 版本或占位文案顶上）；path = 契约解析到的可执行。
        npm: { detected: cat.npm.detail || null, runtime: c.npmVersion || null, path: c.npmPath || null },
        git: { detected: cat.git.detail || null },
        installedAt: c.installedAt || null,
        source: c.source || null,
        ok: cat.node.state === 'ok' && cat.npm.state === 'ok',
        npmRoot: en ? en.npmRoot : null,
        // EnvCatalog 声明式视图（面板环境卡用）
        catalog: (await envCatalogSummary(this)),
        // 平台能力矩阵：三平台静态档位 x 实际工具探测；前端据此做能力感知呈现与降级提示。
        capabilities: (() => { try { return platform.capabilities(); } catch { return null; } })(),
        // 沙箱资源预算总览（W2 governor）：占用/预算/可容纳实例数；非沙箱平台或未装配时为 null。
        sandboxBudget: (() => {
          try {
            return this.instances && typeof this.instances.budgetSnapshot === 'function'
              ? this.instances.budgetSnapshot() : null;
          } catch { return null; }
        })(),
        // 桌面壳看护的观测快照：expose enabled/intervalMs/graceMs/absentForMs/restartsInWindow/
        //   everSawAlive/lastSkipReason/expectedAbsence，使「壳反复拉起失败」在面板可见。
        shellWatchdog: (() => {
          try { return this.shellWatchdog && typeof this.shellWatchdog.status === 'function' ? this.shellWatchdog.status() : null; }
          catch { return null; }
        })(),
      };
    },

    // ---- DSH 即安即用：本体安装状态判定（命令指向的 bin 可执行 + 已管实例版本）----
    dshenvStatus() {
      let bin = null, binOk = false, installed = null, cmdOk = false;
      try {
        const cmd0 = Array.isArray(this.config.command) ? this.config.command : [];
        cmdOk = cmd0.length > 0;
        bin = (cmd0[0] === 'node' && cmd0[1]) ? cmd0[1] : (cmd0[0] || null);
        if (bin) binOk = fs.existsSync(bin);
      } catch {}
      try { if (this.nativeManager && typeof this.nativeManager.installedVersion === 'function') installed = this.nativeManager.installedVersion(); } catch {}
      // main = 守卫核心服务（概念清分）：受管状态以 config.command 有效为准。
      return { installed, bin: bin || null, binOk, managed: cmdOk, phase: this.state.phase() || null };
    },
  },
};
