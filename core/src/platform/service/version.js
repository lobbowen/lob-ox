'use strict';

// 版本地基：统一版本源（仓库根 package.json），避免散落多处。

const fs = require('node:fs');
const path = require('node:path');

/** 守卫版本（双形态）：SEA 构建物形态由 esbuild --define:__DSH_VERSION__ 注入编译期常量，
 *  二进制自包含版本；源码形态回退读仓库根 package.json。 */
function guardVersion() {
  // typeof 对未声明标识符是安全的；define 注入后此处编译期为 typeof "0.10.0" -> 直接返回。
  if (typeof __DSH_VERSION__ !== 'undefined') return String(__DSH_VERSION__);
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = { guardVersion };
