'use strict';

function withoutAutoOpen(cmd) {
  const arr = (Array.isArray(cmd) ? cmd : []).map(String);
  const webAt = arr.indexOf('web');
  if (webAt < 0 || arr.includes('--no-open') || arr.includes('--open')) return cmd;
  const sep = arr.indexOf('--', webAt);
  if (sep < 0) return arr.concat(['--no-open']);
  return arr.slice(0, sep).concat(['--no-open'], arr.slice(sep));
}

module.exports = { withoutAutoOpen };
