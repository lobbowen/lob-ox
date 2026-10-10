'use strict';

const platform = require('../../platform/os/index');

const fs = require('node:fs');
const { EnvCatalog } = require('../../platform/service/env-catalog');
const runtimeContract = require('../../platform/contract/runtime');

async function envCatalogSummary(that) {
  const cat = new EnvCatalog(that.config);
  const extra = {};
  const d = that.dshenvStatus();
  extra.dsh = cat.dshEntry(d.binOk, d.installed, d.bin);
  extra.selfUpdate = cat.selfUpdateEntry();
  return cat.summary(extra, await cat.probeAsync());
}

module.exports = {
  methods: {
    async envStatus() {
      const c = runtimeContract.read() || {};
      const cat = await new EnvCatalog(this.config).probeAsync();
      const en = this.nativeManager && typeof this.nativeManager.checkEnvironment === 'function'
        ? await this.nativeManager.checkEnvironment() : null;
      return {
        node: { detected: cat.node.detail || null, runtime: c.nodeVersion || null, path: c.nodePath || null },
        npm: { detected: cat.npm.detail || null, runtime: c.npmVersion || null, path: c.npmPath || null },
        git: { detected: cat.git.detail || null },
        installedAt: c.installedAt || null,
        source: c.source || null,
        ok: cat.node.state === 'ok' && cat.npm.state === 'ok',
        npmRoot: en ? en.npmRoot : null,
        catalog: (await envCatalogSummary(this)),
        capabilities: (() => { try { return platform.capabilities(); } catch { return null; } })(),
        sandboxBudget: (() => {
          try {
            return this.instances && typeof this.instances.budgetSnapshot === 'function'
              ? this.instances.budgetSnapshot() : null;
          } catch { return null; }
        })(),
      };
    },

    dshenvStatus() {
      let bin = null, binOk = false, installed = null, cmdOk = false;
      try {
        const cmd0 = Array.isArray(this.config.command) ? this.config.command : [];
        cmdOk = cmd0.length > 0;
        bin = (cmd0[0] === 'node' && cmd0[1]) ? cmd0[1] : (cmd0[0] || null);
        if (bin) binOk = fs.existsSync(bin);
      } catch {}
      try { if (this.nativeManager && typeof this.nativeManager.installedVersion === 'function') installed = this.nativeManager.installedVersion(); } catch {}
      return { installed, bin: bin || null, binOk, managed: cmdOk, phase: this.state.phase() || null };
    },
  },
};
