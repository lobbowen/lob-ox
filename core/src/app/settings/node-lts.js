'use strict';

const runtimeContract = require('../../platform/contract/runtime');

module.exports = {
  methods: {
    async nodeLtsStatus() {
      try {
        const now = Date.now();
        const rt = runtimeContract.read ? runtimeContract.read() : null;
        const shellVer = (rt && rt.nodeVersion) || null;
        const ver = shellVer || process.versions.node || '';
        const major = parseInt(String(ver).split('.')[0], 10) || 0;
        const fromShell = !!shellVer;
        return {
          ok: true,
          current: ver,
          major,
          ltsLine: fromShell ? (rt && rt.ltsLine === true) : null,
          source: fromShell ? 'shell-contract' : 'process',
          suggested: fromShell
            ? ('当前 ' + ver + (rt && rt.ltsLine === true ? '（LTS 线）' : ''))
            : 'shell 契约未提供 Node 版本',
          fetchedAt: now,
          cached: false,
        };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  },
};
