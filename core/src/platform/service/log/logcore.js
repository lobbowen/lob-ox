'use strict';

const path = require('node:path');
const Events = require('./events');
const { createLogger, Rotator } = require('./log');
const { EventHub, EventReader } = require('./hub');

let _instance = null;
let _process = null;

class LogCore {
  constructor(opts) {
    const o = opts || {};
    this.process = o.process || 'guard';
    this.logger = createLogger({
      file: o.logFile,
      level: o.logLevel || 'info',
      maxBytes: o.logMaxBytes,
      process: this.process,
    });
    this.events = new Events(o.eventFile, o.eventsMaxBytes, { process: this.process });
    this.dshWriter = o.dshLogFile ? new Rotator(o.dshLogFile, o.logMaxBytes) : null;
    if (o.enableHub === true && o.stateDir) {
      try {
        const aggFile = path.join(path.resolve(o.stateDir), 'events', (o.aggBase || 'state') + '.aggregated.events.log');
        const eventFileAbs = path.resolve(o.eventFile);
        if (aggFile === eventFileAbs) {
          throw new Error('logFile/eventFile 与聚合流文件冲突（' + eventFileAbs + '）：请调整 config.logFile');
        }
        this.hub = new EventHub({
          stateDir: o.stateDir,
          aggBase: o.aggBase || 'state',
          guardEvents: this.events,
          guardLogFile: o.logFile,
          dshLogFile: o.dshLogFile,
          upgradeLogFile: o.upgradeLogFile,
          daemonLogs: o.daemonLogs || {},
          ctlPorts: o.ctlPorts || {},
          eventsMaxBytes: o.eventsMaxBytes,
          logger: this.logger,
        });
        this.events.attachHub(this.hub);
      } catch (e) {
        this.hub = null;
        this.logger && this.logger.warn && this.logger.warn('[logcore] hub init: ' + ((e && e.message) || e));
      }
    } else {
      this.hub = null;
    }
    this.reader = this.hub || new EventReader(this.events);
  }

  event(type, data) { return this.events.append(type, data); }
  eventRaw(rec) { return this.events.appendRaw(rec); }
  get seq() { return this.events.seq; }
}

function init(opts) {
  const p = (opts && opts.process) || null;
  if (typeof p !== 'string' || !p.trim()) throw new Error('LogCore.init 需要 process（非空字符串）');
  if (_instance) {
    if (_process !== p) throw new Error('LogCore 已由 ' + _process + ' 初始化，进程内不允许二次换身份');
    return _instance;
  }
  _process = p;
  _instance = new LogCore(opts || {});
  return _instance;
}

function get() {
  if (_instance) return _instance;
  console.warn('[logcore] get() 在 init() 前调用——返回惰性默认(不落盘)；入口请先 LogCore.init()');
  _process = 'unknown';
  _instance = new LogCore({ process: 'unknown' });
  return _instance;
}

module.exports = { LogCore, init, get, _resetForTest: () => { _instance = null; _process = null; } };
