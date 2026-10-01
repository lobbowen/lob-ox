'use strict';

const fs = require('node:fs');
const path = require('node:path');

// SEA 构建物由 esbuild --define:__DSH_VERSION__ 注入编译期常量；源码形态回退读仓库根 package.json。
function guardVersion() {
  if (typeof __DSH_VERSION__ !== 'undefined') return String(__DSH_VERSION__);
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = { guardVersion };
