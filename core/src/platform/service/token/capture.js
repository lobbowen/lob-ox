'use strict';

const ex = require('../../util/exec');
const service = require('../../os/service');
const persist = require('./persist');
const kinds = require('./kinds');

function parseDshTokenLine(line) {
  const m = /(?:dsh web:)?\s*(?:https?:\/\/127\.0\.0\.1:\d+\/\?token=)([A-Za-z0-9_-]+)/.exec(String(line || ''));
  return m ? m[1] : null;
}

const _channelNoticed = new Set();

async function captureJournal(unit, opts) {
  const o = opts || {};
  const logger = o.logger || console;
  const kind = (typeof o.providerKind === 'function' ? o.providerKind : service.kind)();
  if (kind !== 'systemd') {
    if (!_channelNoticed.has(unit)) {
      _channelNoticed.add(unit);
      logger.info && logger.info('[token] journald 档对 ' + unit + ' 停用：本机服务档=' + kind + '，没有 systemd 单元可查');
    }
    return null;
  }
  const out = await ex.runOutAsync('journalctl', ['--user', '-u', unit + '.service', '--no-pager', '-o', 'cat', '-g', '127\\.0\\.0\\.1:.*token=', '-n', '1'], {
    timeoutMs: 5000,
    logger,
  });
  if (!out) {
    logger.warn && logger.warn('[token] journal capture(' + unit + ') 命令失败或无输出');
    return null;
  }
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = parseDshTokenLine(lines[i]);
    if (t) return { token: t, source: 'journal', line: lines[i] };
  }
  return null;
}

function captureOnce(desc, opts) {
  const src = desc || {};
  if (!kinds.isCaptured(src.kind)) return null;

  if (src.lines && src.lines.length) {
    for (let i = src.lines.length - 1; i >= 0; i--) {
      const t = parseDshTokenLine(src.lines[i]);
      if (t) return { token: t, source: 'stdout', line: src.lines[i] };
    }
  }

  if (src.file) {
    const tail = persist.readTailLines(src.file);
    for (let i = tail.length - 1; i >= 0; i--) {
      const t = parseDshTokenLine(tail[i]);
      if (t) return { token: t, source: 'file', line: tail[i] };
    }
  }
  return null;
}

module.exports = { parseDshTokenLine, captureOnce, captureJournal };
