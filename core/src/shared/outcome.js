'use strict';

const OK = Object.freeze({ kind: 'ok' });
const UNKNOWN = Object.freeze({ kind: 'unknown' });

function fail(error) {
  return { kind: 'fail', error: String(error === undefined || error === null ? '' : error) };
}

function ofBool(b, error) {
  return b ? OK : fail(error || 'unknown failure');
}

const isOk = (o) => !!(o && o.kind === 'ok');
const isFail = (o) => !!(o && o.kind === 'fail');
const isUnknown = (o) => !(o && (o.kind === 'ok' || o.kind === 'fail'));

function expectKnown(o, where) {
  if (!isUnknown(o)) return o;
  throw new Error('Outcome: 未处置的 unknown（' + (where || '未标注调用点') + '）');
}

function unknownAs(o, fallback) {
  return isUnknown(o) ? fallback : o;
}

module.exports = {
  OK, UNKNOWN, fail, ofBool,
  isOk, isFail, isUnknown,
  expectKnown, unknownAs,
};
