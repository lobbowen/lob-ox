'use strict';

const linux = {
  sandboxLaunch: true,
  sandboxEnforcement: 'cgroup',
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

module.exports = { linux, darwin, win32, unknown };
