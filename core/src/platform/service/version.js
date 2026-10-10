'use strict';

const fs = require('node:fs');
const path = require('node:path');

function guardVersion() {
  if (typeof __DSH_VERSION__ !== 'undefined') return String(__DSH_VERSION__);
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = { guardVersion };
