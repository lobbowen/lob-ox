'use strict';

const platform = require('../../platform/os/index');

const matrix = require('../../platform/contract/matrix');

function notify(host, title, body) {
    if (!host.notifyEnabled) return;
    platform.notify(title, body, () => {
      host.notifyEnabled = false;
      host.logger.warn('桌面通知不可用（' + matrix.osTag() + '），已停用');
    });
}

module.exports = { notify };
