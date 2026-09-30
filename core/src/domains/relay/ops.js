'use strict';

// 远程控制编排主体（LanManager）：多实例反向代理（relay）+ 公网隧道（frpc），
// 访问形态由每实例单一 remoteMode（off|lan|wan）驱动。
// 单一数据源是实例存储（沙箱 instances.json + main dsh-main.json）；lanInstances 只是 syncProxy 维护的内存派生缓存。

const managed = require('./managed');
const portsvc = require('./ports');
const { FrpManager } = require('./frp');
const { normalizeRemoteMode, validateWanAccess, normalizeFrpSettings, validateFrpServerSettings, projectRemoteView } = require('./core');
const reconcile = require('./ops/reconcile');
const lanServers = require('./ops/lan-servers');

/** 令牌变化热换到已在运行的 relay（syncProxy 快路径）；返回是否实际下发。 */
function applyRelayToken(host, existing, want) {
  const s = host._lanServers && host._lanServers[existing.id];
  if (!s || typeof s.setToken !== 'function') return false;
  try { s.setToken(want); } catch {}
  existing.token = want;
  if (host.events) host.events.append('lan_token_updated', { id: existing.id, tokenSet: !!want });
  // frp 公网隧道闸依赖 remoteToken：令牌清空后必须复判收敛（不过闸者 syncFrpc 内跳过并停 frpc）。
  host.syncFrpc();
  return true;
}

/** 端口绑定被盗回调（claim 的 onBindingLost）。 */
function onRelayBindingLost(host, inst, e) {
  if (host.events) { try { host.events.append('lan_binding_lost', e); } catch {} }
  if (host.logger && host.logger.warn) host.logger.warn('[syncProxy] ' + inst.id + ' 绑定被盗：' + e.from + ' → 迁移 ' + e.to);
}

class LanManager {
  constructor(opts) {
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.instances = opts.instances; // InstanceManager：沙箱实例配置单一数据源
    this.configPath = opts.configPath || ''; // 端口回收按 configPath 精确匹配，防误杀其它配置的 lan-daemon
    this.mainOf = opts.mainOf || null; // 守卫核心服务的原生主干视图
    // frp 托管经 ctor 注入（默认真实实现），单测可给假 frp。
    this.frp = opts.frp || new FrpManager({ dir: opts.stateDir, logger: this.logger, events: this.events });
    this.lanInstances = []; // [{ id, name, dshPort, wanPort, token, remoteMode }]（派生缓存）
    this._reconcileInFlight = null; // 对账单飞：避免 2s 节拍叠加串行 TCP 探测
    this._lanServers = {};   // id -> http.Server（relay）
    // 令牌不持久化副本，一律按需 tokenOf（DshTokenService 注入）。
    this.tokenOf = opts.tokenOf || (() => '');
    this._proxyChain = Promise.resolve(); // syncProxy 串行队列：防并发拿同一端口
  }

  localAddresses() { return managed.localAddresses(); }
  /** 受管 DSH 合成清单（沙箱 + 原生主干 main）。 */
  _allManaged() { return managed.allManaged({ instances: this.instances, mainOf: this.mainOf }); }
  /** frpc 子进程句柄只读访问器：不暴露 frp 私有对象，供 daemon 优雅停机等待其退出。 */
  frpChild() { return (this.frp && this.frp.child) || null; }

  list() {
    this.reconcile().catch(() => {}); // 对账异步：剔除孤儿/陈旧代理，不阻塞 list 响应
    const addresses = this.localAddresses();
    const insts = this._allManaged();
    const remoteInsts = insts.filter((x) => normalizeRemoteMode(x.remoteMode) !== 'off');
    // 幂等自愈：非 off 实例异步补建代理（不可达由 syncProxy 内 TCP 裁决跳过）。
    for (const inst of remoteInsts) {
      if (!this.lanInstances.some((p) => p.dshPort === inst.port)) {
        this._syncProxyQueued(inst).catch((e) => this.logger.warn && this.logger.warn('syncProxy failed: ' + e.message));
      }
    }
    const frpSt = this.frp ? this.frp.status() : { running: false, settings: {} };
    const items = remoteInsts.map((inst) => {
      const proxy = this.lanInstances.find((p) => p.dshPort === inst.port);
      const srv = this._lanServers && this._lanServers[inst.id];
      const st = (srv && typeof srv.status === 'function') ? srv.status() : null;
      const inject = st ? {
        tokenSet: !!st.tokenSet, cookieReady: !!st.cookieReady,
        lastOkAt: st.lastOkAt || null, lastError: st.lastError || null, lastErrorAt: st.lastErrorAt || null,
      } : null;
      const remote = projectRemoteView({
        mode: normalizeRemoteMode(inst.remoteMode),
        relayListening: !!(this._lanServers && this._lanServers[inst.id]),
        tokenSet: !!String(inst.remoteToken || '').trim(),
        cookieReady: !!(st && st.cookieReady),
        frpcRunning: !!frpSt.running,
        serverAddr: (frpSt.settings && frpSt.settings.serverAddr) || '',
        lanAddress: addresses[0] || '',
        wanPort: proxy ? proxy.wanPort : null,
      });
      return {
        id: inst.id, name: inst.name, dshPort: inst.port,
        wanPort: proxy ? proxy.wanPort : null,
        token: inst.remoteToken || '',
        dshToken: this.tokenOf(inst.id) || '', // 令牌按需从令牌池读取
        running: !!this._lanServers && !!this._lanServers[inst.id],
        inject, remote,
      };
    });
    return { items, addresses };
  }
  frpStatus() {
    const st = this.frp ? this.frp.status() : { installed: false, running: false };
    const insts = this._allManaged();
    st.instancesExposed = insts
      .filter((x) => normalizeRemoteMode(x.remoteMode) === 'wan')
      .map((x) => {
        const proxy = this.lanInstances.find((p) => p.dshPort === x.port);
        return { id: x.id, name: x.name, port: proxy ? proxy.wanPort : null };
      });
    return st;
  }
  /** frpc 操作门面（settings/install 统一入口）。 */
  async frpAction(action, body) {
    const j = body || {};
    if (action === 'settings') {
      const cur = this.frp ? this.frp.loadSettings() : {};
      const next = normalizeFrpSettings(j, cur);
      // 写前一致性：serverAddr 为空但仍有 wan 意图时拒存（否则隧道静默失效）；
      // 无 wan 实例时空地址合法（纯配置编辑）。
      if (!String(next.serverAddr || '').trim() && this._hasWanIntent()) {
        return { ok: false, error: validateFrpServerSettings(next).error };
      }
      if (this.frp) this.frp.saveSettings(next);
      this.syncFrpc();
      return { ok: true, ...this.frpStatus() };
    }
    if (action === 'install') {
      if (!this.frp) return { ok: false, error: 'frpmgr 不可用' };
      return this.frp.install((msg) => { try { this.logger.info('[frpc] ' + msg); } catch {} });
    }
    return { ok: false, error: '未知 frp 操作: ' + action };
  }
  /** 受管清单是否有 wan 意图：含尚未建立代理的实例（磁盘态即算）。 */
  _hasWanIntent() {
    return this._allManaged().some((x) => normalizeRemoteMode(x.remoteMode) === 'wan');
  }
  /** 实例变化后同步 frpc 配置与进程（尽力而为，不抛异常影响主流程）。
   *  建隧道前复校 wan 闸（core.validateWanAccess，与写入口同一实现）：冷启动直接按磁盘态组装隧道，
   *  历史遗留「wan 态但令牌为空」会绕开写侧闸，在网络边界重现公网零认证暴露——不过闸即跳过该隧道。 */
  syncFrpc() {
    if (!this.frp) return;
    try {
      const all = this.lanInstances || [];
      const safe = all.filter((inst) => {
        if (normalizeRemoteMode(inst.remoteMode) !== 'wan') return true;
        const v = validateWanAccess({ remoteToken: String(inst.token || '') });
        if (!v.ok) {
          if (this.logger && this.logger.warn) this.logger.warn('[frpc] 实例 ' + inst.id + ' 公网访问未过闸，已跳过建隧道：' + v.error);
          if (this.events) this.events.append('lan_frp_blocked', { id: inst.id, reason: v.error });
          return false;
        }
        return true;
      });
      const r = this.frp.syncFromInstances(safe);
      if (r && r.needInstall) this.logger.info && this.logger.info('frpc not installed; WAN exposure pending install');
    } catch (e) {
      this.logger.warn && this.logger.warn('frpc sync failed: ' + e.message);
    }
  }
  /** 远程代理对账：注册只与「remoteMode!=off」绑定；relay 运行 = 目标存活；孤儿注册移除。
   *  单飞：内部逐实例串行 await targetReachable（每个最多 600ms）而被 2s 节拍反复触发，
   *  同刻只允许一轮在跑，后续调用复用同一在途 Promise。刻意不加 async——包一层 Promise 会丢单飞身份。 */
  reconcile() {
    if (this._reconcileInFlight) return this._reconcileInFlight;
    this._reconcileInFlight = this._reconcileOnce()
      .catch((e) => { this.logger.warn && this.logger.warn('[reconcile] ' + ((e && e.message) || e)); })
      .finally(() => { this._reconcileInFlight = null; });
    return this._reconcileInFlight;
  }
  /** 对账主体（委托 ops/reconcile.js）；方法名不可改：单飞包装与门禁按此名调用。 */
  async _reconcileOnce() { return reconcile.reconcileOnce(this); }
  targetReachable(inst) { return reconcile.targetReachable(inst); }
  _syncProxyQueued(inst) { return reconcile.syncProxyQueued(this, inst); }
  /** 实例被删除时移除其局域网代理。 */
  async removeProxyForInstance(instId) { return reconcile.removeProxyForInstance(this, instId); }

  /** 同步某实例的远程访问代理：remoteMode!=off 且目标在监听时创建 relay，off 拆除。
   *  wan 不引入第二监听/第二端口（隧道口与 relay 口恒同号，见 core.buildFrpcToml）；
   *  端口绑定唯一权威是 relay 槽位注册表，实例记录不存 wanPort 镜像。 */
  async syncProxy(inst) {
    if (!inst) return;
    const mode = normalizeRemoteMode(inst.remoteMode);
    if (mode !== 'off') {
      const owner = 'relay:' + inst.id;
      // 已登记且端口有效：走幂等快路径，不重分配端口。
      const existing = this.lanInstances.find((p) => p.dshPort === inst.port);
      if (existing && existing.wanPort) {
        const srv = this._lanServers && this._lanServers[inst.id];
        if (!srv) this._startLanServer(existing);
        // 令牌变化必须热换到运行中的 relay，否则旧快路径直接 return 会让令牌无声残留。
        const want = String(inst.remoteToken || '');
        if (existing.token !== want) applyRelayToken(this, existing, want);
        // lan<->wan 切换：隧道随 mode 增删。
        if (existing.remoteMode !== mode) {
          existing.remoteMode = mode;
          this.syncFrpc();
        }
        return;
      }
      // 目标必须真的 TCP 可达，否则代理无意义且白占端口。
      if (!(await this.targetReachable(inst))) return;
      // 槽位仲裁：绑定记忆在注册表（claim 按 owner 自动复用）；main 无绑定时的建议槽位派生自池定义，禁池外硬编码。
      const relayPool = portsvc.rangeOf('relay');
      const slot = await portsvc.claim('relay', owner, {
        preferred: !existing && inst.id === 'main' ? relayPool.base : undefined,
        onBindingLost: (e) => onRelayBindingLost(this, inst, e),
        configPath: this.configPath,
      });
      if (!slot || slot.conflict) {
        if (this.logger && this.logger.warn) this.logger.warn('[syncProxy] ' + inst.id + ' relay 槽位冲突（' + (slot && slot.port) + ' 被外部占用且无法回收），不静默跳号，等待下轮');
        return;
      }
      const wanPort = slot.port;
      // 换绑/迁移前先关旧端口：防同进程新旧两族监听并存。
      const oldSrv = this._lanServers && this._lanServers[inst.id];
      const oldPort = existing && existing.wanPort;
      if (oldSrv && oldPort && oldPort !== wanPort) {
        try { oldSrv.close(() => {}); } catch {}
        try { if (typeof oldSrv.closeAllConnections === 'function') oldSrv.closeAllConnections(); } catch {}
        delete this._lanServers[inst.id];
        if (this.logger && this.logger.info) this.logger.info('[syncProxy] ' + inst.id + ' 关闭旧端口 ' + oldPort + ' server（换绑 ' + wanPort + '）');
      }
      // 单 owner 单记录：清重复残留。
      portsvc.purgeDuplicates(owner, wanPort);
      portsvc.ensureMarked(wanPort, owner);
      // 代理条目不放 dshToken：需要时经 tokenOf 按需取。
      const proxyInst = { id: inst.id, name: inst.name, dshPort: inst.port, wanPort, token: inst.remoteToken || '', remoteMode: mode };
      if (existing) { Object.assign(existing, proxyInst); }
      else this.lanInstances.push(proxyInst);
      this._startLanServer(existing || proxyInst);
      if (this.events) this.events.append('lan_instance_added', { id: inst.id, name: inst.name, dshPort: inst.port, wanPort });
      this.syncFrpc();
    } else {
      // 关闭远程：停 relay 并移除派生缓存条目，但保留注册表绑定（再开经 claim 复用同端口）。
      const proxy = this.lanInstances.find((p) => p.dshPort === inst.port);
      if (proxy) {
        this._stopLanServer(proxy.id);
        this.lanInstances = this.lanInstances.filter((p) => p.id !== proxy.id);
        if (this.events) this.events.append('lan_instance_removed', { id: proxy.id, reason: 'disabled' });
        this.syncFrpc();
      }
    }
  }
  /** 实例启动/停止时联动远程代理（委托 ops/reconcile.js：停止只停 relay，保留注册）。 */
  async instanceStart(inst) { return reconcile.instanceStart(this, inst); }
  instanceStop(inst) { return reconcile.instanceStop(this, inst); }
  _startLanServer(inst) { return lanServers.startLanServer(this, inst); }
  _stopLanServer(id) { return lanServers.stopLanServer(this, id); }
  /** 守卫优雅退出：停全部 relay 与 frpc。 */
  shutdown() { return lanServers.shutdown(this); }
  /** 令牌变化下发到既有 relay（热换 DSH 会话 cookie）；本域不持久化令牌。 */
  applyToken(instId) { return lanServers.applyToken(this, instId); }
}

module.exports = { LanManager };
