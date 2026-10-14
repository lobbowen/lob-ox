'use strict';

// SUPPORTED：产品支持矩阵——「本产品在哪个平台声明支持哪些能力」。
// 这里的字段永不表达本机可用性。本机可用性由 os/index.js 的 capabilities() 实时探测得出
// （面板展示的也是那份）。两者曾共用一张表，导致"问产品支持"读到被探测结果污染的表。
const linux = {
  sandboxLaunch: true,
  
  sandboxEnforcement: 'supervise',
  pidAdoption: true,
  processTreeKill: true,
  desktopNotify: true,
  autostart: true,
  frpExpose: true,
  openBrowser: true,
  hostService: 'systemd',
  guardAutostart: true,
  guardSelfHeal: true,
  shellAutostart: true,
  shellSelfHeal: true,
};

const darwin = {
  sandboxLaunch: true,
  sandboxEnforcement: 'supervise',
  pidAdoption: true,
  processTreeKill: true,
  desktopNotify: true,
  autostart: true,
  frpExpose: true,
  openBrowser: true,
  hostService: 'launchd',
  guardAutostart: true,
  guardSelfHeal: true,
  shellAutostart: true,
  shellSelfHeal: true,
};

const win32 = {
  sandboxLaunch: true,
  sandboxEnforcement: 'supervise',
  pidAdoption: true,
  processTreeKill: true,
  desktopNotify: true,
  autostart: true,
  frpExpose: true,
  openBrowser: true,
  hostService: 'windows-service',
  guardAutostart: true,
  guardSelfHeal: true,
  shellAutostart: true,
  shellSelfHeal: true,
};

const unknown = {
  sandboxLaunch: false, sandboxEnforcement: 'none',
  pidAdoption: false, processTreeKill: false,
  desktopNotify: false, autostart: false, frpExpose: false,
  openBrowser: false,
  hostService: 'none',
  guardAutostart: false, guardSelfHeal: false,
  shellAutostart: false, shellSelfHeal: false,
};

const SUPPORTED = Object.freeze({ linux, darwin, win32, unknown });

module.exports = { SUPPORTED };