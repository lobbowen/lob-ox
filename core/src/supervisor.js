'use strict';

const path = require('node:path');

// src/supervisor.js —— 进程入口 + 组装根，有意保持薄壳。
// 职责：归一化配置；调 app/assembly/compose.js 组装全部子系统（唯一 DI 点，切面经
//   app/assembly/facets.js 显式装到实例，不挂 prototype）；暴露 api/*.js 与测试消费的兼容门面。
// 契约：业务体不得上提至此（DS-G7 <=200 行 / DF-1 <=150 行）；批量挂 prototype 属硬失败（DG-8）。

const platformConfig = require('./platform/service/config');
// DS-G4（反转法）：业务域配置键声明的唯一处是 app/settings；root 仅作兼容门面。
const { extension: domainConfigExtension } = require('./app/settings/domain-config');
const normalize = (raw) => platformConfig.normalize(raw, domainConfigExtension());
const { composeSystem } = require('./app/assembly/compose');
const { createServer } = require('./api/index');

class Supervisor {
  /** @param rawConfig 归一化前配置  @param configPath 配置回写路径（缺省不回写） */
  constructor(rawConfig, configPath) {
    // app 不得 require api（DS-3），故 createServer 由 root 注入给切面装配。
    composeSystem(this, rawConfig, configPath, { createServer });
  }

  /** LanManager 惰性获取：仅 config.lanDaemon !== true（守卫内嵌承载 relay）时创建本地实例。
   *  daemon 模式守卫内始终无 relay 能力，杜绝漏网写入 relay 端口（漂移族 ghost 根因）。
   *  必须留在 root：创建需 configPath/instances/dsh-main 等组装期上下文。 */
  get lan() {
    if (this.lanDaemonEnabled()) return null;
    if (!this._lan) {
      // 有意的惰性 require（DF-8 例外）：daemon 模式结构性排除 relay，relay 域经 app 层装配；
      //   保留在 getter 内，不上提顶层。
      const LanManager = require('./domains/relay').LanManager;
      this._lan = new LanManager({
        configPath: this.configPath || '',
        stateDir: path.dirname(this.config.stateFile),
        logger: this.logger,
        events: this.events,
        instances: this.instances,
        mainOf: () => {
          const m = this._readDshMain();
          m.id = 'main';
          m.name = '主实例';
          m.port = Number(this.config.targetPort || 3080);
          m.domain = 'native';
          m.kind = 'native';
          return m;
        },
        tokenOf: (id) => this.tokenService.get(id),
      });
    }
    return this._lan;
  }
  set lan(v) { this._lan = v; } // 测试注入 mock 用；生产 daemon 模式守卫不主动 set

  /** 完整启动：HTTP 服务 + 编排层启动序列（app/assembly/bootstrap）。 */
  start() {
    this._apiStart();
    return this._bootstrap();
  }
}

module.exports = { Supervisor, normalize };
