'use strict';

const platform = require('../../platform/os/index');

const matrix = require('../../platform/contract/matrix');

// 桌面通知（守卫自身行为），经 platform/os 发送。


function notify(host, title, body) {
    if (!host.notifyEnabled) return;
    platform.notify(title, body, () => {
      host.notifyEnabled = false; // 环境无通知工具，静默停用
      host.logger.warn('桌面通知不可用（' + matrix.osTag() + '），已停用');
    });
}

module.exports = { notify };
