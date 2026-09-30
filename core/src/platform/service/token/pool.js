'use strict';

// 令牌池（DSH-TOKEN-CONTRACT 契约3/4，TK-1/TK-4/TK-8）：唯一事实源，消费方一律按需 get()/getRecord()，不得自行缓存。
// 任何值变化、清空或注销必须经广播（clear/detach 无静默删除路径）；用户配置类权威在配置存储，list() 排除、attach 只登记。
// 落盘（TK-5/TK-6）全部委托 persist/snapshot，本文件不直连 fs；池快照需显式 opts.poolFile，缺省不落盘以免测试互相污染。

const path = require('node:path');
const persist = require('./persist');
const kinds = require('./kinds');
const capture = require('./capture');
const { FollowBus } = require('./follow');
const snapshot = require('./snapshot');
const { configureKindInference, kindInference, inferKind } = require('./infer');

/** 进入 RUNNING 后的捕获退避时间（ms），覆盖端口先起、URL 后打印的典型窗口。 */
const CAPTURE_RETRY_MS = [0, 1500, 4000, 8000, 15000, 30000];
const BACKFILL_THROTTLE_MS = 30000;
/** stdout 行缓冲上限，只保留最近的 URL 候选。 */
const MAX_PENDING_LINES = 20;

class TokenPool {
  /** @param {object} opts { logger, events, poolFile } */
  constructor(opts) {
    const o = opts || {};
    this.logger = o.logger || console;
    this.events = o.events || null;
    this._records = new Map();
    this._sources = new Map();
    this._bus = new FollowBus({ logger: this.logger });
    this._schedules = new Map(); // id 到 { seq, i, timer }；新轮次 seq 递增使旧轮次作废
    this._seq = 0;
    this._attachGen = new Map(); // id 到登记代：attach/clear 各自递增，使在途 journal 回填作废（B2-6a）
    this._journalFn = o.journal || capture.captureJournal; // journal 档显式注入口：CI 造不出 journalctl 输出，行为断言靠它
    this._backfillAt = new Map();
    this._poolFile = o.poolFile ? path.resolve(o.poolFile) : null;
    this._loaded = false;
  }

  /* 来源登记 */
  /** 登记或更新目标的令牌来源，重复 attach 幂等并保留已推送的 stdout 行；kind 缺省时按源形态推断（infer.js）。
   *  kind 必须在 kinds.js 登记（契约1），完全无法判定时返回 false，避免幽灵令牌入池。 */
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
    // 换源即换代（含同参重复 attach，无害）：在途 journal 回填的 unit/file 属旧代事实，不得再落。
    this._attachGen.set(id, (this._attachGen.get(id) || 0) + 1);
    const rec = this._records.get(id);
    if (rec) rec.kind = kind; // 记录已存在时补齐 kind（池快照载入的记录也带 kind，这里只兜底）
    return true;
  }

  /** 注销目标的来源与全部令牌状态（实例删除/模式切换永久放弃时调用）。
   *  清令牌必须广播 null，否则消费方会继续用已注销目标的旧代令牌。 */
  detach(id) {
    this._cancelSchedule(id);
    this._sources.delete(id);
    this._backfillAt.delete(id);
    this.clear(id);
  }

  /* 统一捕获（源无关） */
  /** 主动捕捉一次：按源优先级取“最新一条”URL 行的令牌，有变化则入库并广播。
   *  stdout/文件档同步返回；journal 档非阻塞发射：同步 journalctl 在生命周期 tick 里会冻结事件循环（见 capture.js）。 */
  capture(id) {
    const src = this._sources.get(id);
    if (!src) return null;
    const hit = capture.captureOnce({ kind: src.kind, unit: src.unit, file: src.file, lines: src.lines }, { logger: this.logger });
    if (hit) {
      if (src.file) this._persistLine(id, src.file, hit.line);
      return this._commit(id, hit.token, hit.source);
    }
    // journald（systemd 托管）末位兜底：异步发射不占调用线程。
    // B2-6a attach 世代守卫（照抄 scheduleCapture 的作废法）：发射前后各校验一次换代，
    //   且源一律按 id 从池重取——闭包 src 的 unit/file 属旧代事实，
    //   否则 detach/clear 后迟到的死令牌会以新 gen 回灌（违反 TK-8 无静默复活）。
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
        .catch(() => { /* 回填失败无碍：下个节流周期再来 */ });
    }
    return null;
  }

  /** spawn 托管路径：推送一行 DSH stdout（不触发 journalctl，免逐行 I/O）。 */
  feedLine(id, line) {
    if (!id || !line) return null;
    let src = this._sources.get(id);
    if (!src) {
      // TK-3：隐式源必须走与 attach 相同的分类闸——推断不出或 kind 未登记一律拒绝入池，
      //   否则此旁路绕开登记门禁，造成幽灵令牌入池。
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

  /* 捕获策略（服务内统一） */
  /** 进入 RUNNING 后按退避计划重试捕获直至窗口结束；新轮次（seq 递增）或 detach 使旧轮次作废。 */
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

  /** 周期兜底：令牌仍为空时按节流从来源回填（幂等，可每 tick 调用）。 */
  ensureCaptured(id) {
    const rec = this._records.get(id);
    if (rec && rec.value) return; // 最新性由轮换时的 scheduleCapture 保证
    // 守卫重启后内存为空，磁盘可能已有上一代令牌，先载入再判定。
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

  /* 生命周期 */
  /** 清空某目标的令牌与调度；TK-8：必须广播 null（消费方立刻丢弃旧代令牌）。
   *  stdout 行缓冲同属旧代状态必须一并清：残留行会被 ensureCaptured 再“捕获”，
   *  以新 gen 把已死令牌回灌进恢复文件。 */
  clear(id) {
    this._cancelSchedule(id);
    this._backfillAt.delete(id);
    const src = this._sources.get(id);
    if (src && src.lines && src.lines.length) src.lines.length = 0;
    // 换代使在途 journal 回填作废：迟到结果若仍提交，等于刚广播 null 又静默复活死令牌。
    this._attachGen.set(id, (this._attachGen.get(id) || 0) + 1);
    this._records.delete(id);
    this._persistPool();
    this._bus.emit(id, null, null);
  }

  /* 查询与订阅 */
  /** 当前令牌（空串表示未捕获到）。 */
  get(id) {
    let rec = this._records.get(id);
    if ((!rec || !rec.value) && !this._loaded) {
      this._loadPoolFile();
      rec = this._records.get(id);
    }
    return rec ? (rec.value || '') : '';
  }

  /** 当前令牌记录（含"代"）；未捕获返回 null。返回副本（TK-4）。 */
  getRecord(id) {
    let rec = this._records.get(id);
    if ((!rec || !rec.value) && !this._loaded) {
      this._loadPoolFile();
      rec = this._records.get(id);
    }
    if (!rec) return null;
    return { value: rec.value, gen: rec.gen, source: rec.source, at: rec.at };
  }

  /** 展示用列表（含代号与来源）；契约4：不得含用户配置类（TK-4/TK-7）。 */
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

  /** 订阅令牌变化：fn(id, value|null, record)。返回取消订阅函数。 */
  onChange(fn) {
    return this._bus.on(fn);
  }

  /* 内部 */
  /** 提交一次变化：值相同视为轮换收敛（不递增代、不广播）；值变化则 gen+1 并广播。 */
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
    if (this.events) { try { this.events.append('dsh_token_captured', { id, source: rec.source, gen: rec.gen }); } catch { /* 事件失败不影响令牌链路 */ } }
    if (this.logger && this.logger.info) this.logger.info('[token] captured for ' + id + ' (source=' + rec.source + ', gen=' + rec.gen + ')');
    this._bus.emit(id, rec.value, { value: rec.value, gen: rec.gen, source: rec.source, at: rec.at });
    return value;
  }

  /** 把命中令牌的原文行写入恢复文件（统一经 persist：脱敏 + 0600 + 轮转）。 */
  _persistLine(id, file, line) {
    const r = persist.appendByRotation(file, line, { maxBytes: persist.PERSIST_LIMITS.MAX_BYTES });
    if (!r.ok) this.logger.warn && this.logger.warn('[token] persist file(' + id + ') failed: ' + (r.reason || 'unknown'));
    else if (r.rotated) this.logger.info && this.logger.info('[token] persist file(' + id + ') 超限已轮转（备份保留原文，未清空）');
  }

  /** 取消某目标的退避重试，并让在途轮次作废（旧轮次 setTimeout 醒来后自查 seq 退出）。 */
  _cancelSchedule(id) {
    const st = this._schedules.get(id);
    if (st && st.timer) { try { clearTimeout(st.timer); } catch { /* 定时器已触发 */ } }
    this._schedules.delete(id);
  }

  /** 池快照落盘（仅 poolFile 配置时）。仅持久化 TK-7 允许的分类（委托 snapshot 原子写）。 */
  _persistPool() {
    if (!this._poolFile) return;
    const entries = [];
    for (const [id, r] of this._records) {
      if (!r.value) continue;                    // 空值不落盘，没有令牌不是一种持久状态
      if (!kinds.isPersistent(r.kind)) continue; // 用户配置/派生/自签类绝不写入池文件
      entries.push({ id, value: r.value, gen: r.gen, source: r.source, at: r.at, kind: r.kind });
    }
    const w = snapshot.saveTokens(this._poolFile, entries);
    if (!w.ok) this.logger.warn && this.logger.warn('[token] pool file persist failed: ' + (w.reason || 'unknown'));
  }

  /** 从池快照恢复（只尝试一次；失败静默，恢复只是加速项，真值仍可由捕获重获）。 */
  _loadPoolFile() {
    if (this._loaded) return;
    this._loaded = true; // 先置位，读失败也不重复读盘（幂等由内存优先保证）
    if (!this._poolFile) return;
    for (const e of snapshot.loadTokens(this._poolFile)) {
      if (this._records.has(e.id)) continue; // 内存中更新的代优先
      this._records.set(e.id, { value: e.value, gen: e.gen, source: e.source, at: e.at, kind: e.kind });
    }
  }
}

module.exports = {
  TokenPool,
  configureKindInference,
  kindInference,
};
