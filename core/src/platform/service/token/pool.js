'use strict';

const path = require('node:path');
const persist = require('./persist');
const kinds = require('./kinds');
const capture = require('./capture');
const { FollowBus } = require('./follow');
const snapshot = require('./snapshot');
const { configureKindInference, kindInference, inferKind } = require('./infer');

const CAPTURE_RETRY_MS = [0, 1500, 4000, 8000, 15000, 30000];
const BACKFILL_THROTTLE_MS = 30000;
const MAX_PENDING_LINES = 20;

class TokenPool {
  constructor(opts) {
    const o = opts || {};
    this.logger = o.logger || console;
    this.events = o.events || null;
    this._records = new Map();
    this._sources = new Map();
    this._bus = new FollowBus({ logger: this.logger });
    this._schedules = new Map();
    this._seq = 0;
    this._attachGen = new Map();
    this._journalFn = o.journal || capture.captureJournal;
    this._backfillAt = new Map();
    this._poolFile = o.poolFile ? path.resolve(o.poolFile) : null;
    this._loaded = false;
  }

  attach(id, src) {
    if (!id) return false;
    const s = src || {};
    const prev = this._sources.get(id);
    let kind = s.kind || (prev && prev.kind) || null;
    if (kind && !kinds.isKnownKind(kind)) {
      this.logger.warn && this.logger.warn('[token] attach(' + id + ') 拒绝：kind 未登记（§1）：' + String(kind));
      return false;
    }
    if (!kind) kind = inferKind(id, s);
    if (!kind) {
      this.logger.warn && this.logger.warn('[token] attach(' + id + ') 拒绝：缺少 kind 且无法从源形态推断（§1 要求登记分类）');
      return false;
    }
    const unit = s.unit || (prev && prev.unit) || null;
    const file = s.file || (prev && prev.file) || null;
    this._sources.set(id, { kind, unit, file, lines: (prev && prev.lines) || [] });
    this._attachGen.set(id, (this._attachGen.get(id) || 0) + 1);
    const rec = this._records.get(id);
    if (rec) rec.kind = kind;
    return true;
  }

  detach(id) {
    this._cancelSchedule(id);
    this._sources.delete(id);
    this._backfillAt.delete(id);
    this.clear(id);
  }

  // journalctl 同步查询会冻结生命周期 tick 的事件循环，故 journal 档非阻塞发射（见 capture.js）。
  capture(id) {
    const src = this._sources.get(id);
    if (!src) return null;
    const hit = capture.captureOnce({ kind: src.kind, unit: src.unit, file: src.file, lines: src.lines }, { logger: this.logger });
    if (hit) {
      if (src.file) this._persistLine(id, src.file, hit.line);
      return this._commit(id, hit.token, hit.source);
    }
    // attach 世代守卫：发射前后各校验一次换代，源按 id 从池重取（闭包 src 的 unit/file 属旧代事实），防死令牌以新 gen 回灌。
    if (src.unit && kinds.isCaptured(src.kind)) {
      const gen = this._attachGen.get(id) || 0;
      const fresh = () => ((this._attachGen.get(id) || 0) === gen ? this._sources.get(id) : null);
      Promise.resolve()
        .then(() => {
          const cur = fresh();
          return cur ? this._journalFn(cur.unit, { logger: this.logger }) : null;
        })
        .then((j) => {
          if (!j) return;
          const cur = fresh();
          if (!cur) return;
          if (cur.file) this._persistLine(id, cur.file, j.line);
          this._commit(id, j.token, j.source);
        })
        .catch(() => {  });
    }
    return null;
  }

  feedLine(id, line) {
    if (!id || !line) return null;
    let src = this._sources.get(id);
    if (!src) {
      const k = inferKind(id, {});
      if (!k || !kinds.isKnownKind(k)) return null;
      src = { kind: k, unit: null, file: null, lines: [] };
      this._sources.set(id, src);
    }
    src.lines.push(String(line));
    if (src.lines.length > MAX_PENDING_LINES) src.lines.splice(0, src.lines.length - MAX_PENDING_LINES);
    const t = capture.parseDshTokenLine(line);
    if (t) {
      if (src.file) this._persistLine(id, src.file, line); 
      return this._commit(id, t, 'stdout');
    }
    return null;
  }

  scheduleCapture(id) {
    if (!this._sources.has(id)) return;
    const seq = ++this._seq;
    const st = { seq, i: 0, timer: null };
    this._schedules.set(id, st);
    const tryOnce = () => {
      const cur = this._schedules.get(id);
      if (!cur || cur.seq !== seq) return;
      this.capture(id);
      st.i += 1;
      if (st.i < CAPTURE_RETRY_MS.length) {
        st.timer = setTimeout(tryOnce, CAPTURE_RETRY_MS[st.i]);
      }
    };
    tryOnce();
  }

  ensureCaptured(id) {
    const rec = this._records.get(id);
    if (rec && rec.value) return;
    if (!this._loaded) {
      this._loadPoolFile();
      const r2 = this._records.get(id);
      if (r2 && r2.value) return;
    }
    const last = this._backfillAt.get(id) || 0;
    const now = Date.now();
    if (now - last < BACKFILL_THROTTLE_MS) return;
    this._backfillAt.set(id, now);
    this.capture(id);
  }

  clear(id) {
    this._cancelSchedule(id);
    this._backfillAt.delete(id);
    const src = this._sources.get(id);
    if (src && src.lines && src.lines.length) src.lines.length = 0;
    this._attachGen.set(id, (this._attachGen.get(id) || 0) + 1);
    this._records.delete(id);
    this._persistPool();
    this._bus.emit(id, null, null);
  }

  get(id) {
    let rec = this._records.get(id);
    if ((!rec || !rec.value) && !this._loaded) {
      this._loadPoolFile();
      rec = this._records.get(id);
    }
    return rec ? (rec.value || '') : '';
  }

  getRecord(id) {
    let rec = this._records.get(id);
    if ((!rec || !rec.value) && !this._loaded) {
      this._loadPoolFile();
      rec = this._records.get(id);
    }
    if (!rec) return null;
    return { value: rec.value, gen: rec.gen, source: rec.source, at: rec.at };
  }

  list() {
    this._loadPoolFile();
    const ids = new Set();
    for (const id of this._sources.keys()) ids.add(id);
    for (const id of this._records.keys()) ids.add(id);
    const out = [];
    for (const id of ids) {
      const src = this._sources.get(id) || null;
      const rec = this._records.get(id) || null;
      const kind = (src && src.kind) || (rec && rec.kind) || null;
      if (kinds.isUserConfigKind(kind)) continue;
      out.push({
        id,
        kind,
        value: rec ? (rec.value || '') : '',
        gen: rec ? rec.gen : 0,
        source: rec ? rec.source : null,
        at: rec ? rec.at : null,
      });
    }
    return out;
  }

  onChange(fn) {
    return this._bus.on(fn);
  }

  _commit(id, value, source) {
    if (!value) return null;
    const prev = this._records.get(id);
    if (prev && prev.value === value) return value;
    const src = this._sources.get(id);
    const rec = {
      value,
      gen: (prev ? prev.gen : 0) + 1,
      source: source || 'unknown',
      at: Date.now(),
      kind: (src && src.kind) || (prev && prev.kind) || null,
    };
    this._records.set(id, rec);
    this._persistPool();
    if (this.events) { try { this.events.append('dsh_token_captured', { id, source: rec.source, gen: rec.gen }); } catch {  } }
    if (this.logger && this.logger.info) this.logger.info('[token] captured for ' + id + ' (source=' + rec.source + ', gen=' + rec.gen + ')');
    this._bus.emit(id, rec.value, { value: rec.value, gen: rec.gen, source: rec.source, at: rec.at });
    return value;
  }

  _persistLine(id, file, line) {
    const r = persist.appendByRotation(file, line, { maxBytes: persist.PERSIST_LIMITS.MAX_BYTES });
    if (!r.ok) this.logger.warn && this.logger.warn('[token] persist file(' + id + ') failed: ' + (r.reason || 'unknown'));
    else if (r.rotated) this.logger.info && this.logger.info('[token] persist file(' + id + ') 超限已轮转（备份保留原文，未清空）');
  }

  _cancelSchedule(id) {
    const st = this._schedules.get(id);
    if (st && st.timer) { try { clearTimeout(st.timer); } catch {  } }
    this._schedules.delete(id);
  }

  _persistPool() {
    if (!this._poolFile) return;
    const entries = [];
    for (const [id, r] of this._records) {
      if (!r.value) continue;
      if (!kinds.isPersistent(r.kind)) continue;
      entries.push({ id, value: r.value, gen: r.gen, source: r.source, at: r.at, kind: r.kind });
    }
    const w = snapshot.saveTokens(this._poolFile, entries);
    if (!w.ok) this.logger.warn && this.logger.warn('[token] pool file persist failed: ' + (w.reason || 'unknown'));
  }

  _loadPoolFile() {
    if (this._loaded) return;
    this._loaded = true;
    if (!this._poolFile) return;
    for (const e of snapshot.loadTokens(this._poolFile)) {
      if (this._records.has(e.id)) continue;
      this._records.set(e.id, { value: e.value, gen: e.gen, source: e.source, at: e.at, kind: e.kind });
    }
  }
}

module.exports = {
  TokenPool,
  configureKindInference,
  kindInference,
};
