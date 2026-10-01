'use strict';

const path = require('node:path');

const platformConfig = require('./platform/service/config');
const { extension: domainConfigExtension } = require('./app/settings/domain-config');
const normalize = (raw) => platformConfig.normalize(raw, domainConfigExtension());
const { composeSystem } = require('./app/assembly/compose');
const { createServer } = require('./api/index');

class Supervisor {
  constructor(rawConfig, configPath) {
    composeSystem(this, rawConfig, configPath, { createServer });
  }

  get lan() {
    if (this.lanDaemonEnabled()) return null;
    if (!this._lan) {
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
  set lan(v) { this._lan = v; }

  start() {
    this._apiStart();
    return this._bootstrap();
  }
}

module.exports = { Supervisor, normalize };
