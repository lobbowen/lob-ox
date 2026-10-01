'use strict';

const { semverCompare } = require('../../shared/version');

const OUR_RELEASE_SCOPE = '@lob-ox/';

function isOurReleasePackage(pkg) {
  return typeof pkg === 'string' && pkg.startsWith(OUR_RELEASE_SCOPE);
}

const ROLLBACK_FLOOR_VERSION = '0.1.5-BETA.10';

const ROLLBACK_MAX_AGE_DAYS = 30;

function rollbackAllowed(version, meta, o) {
  const floor = typeof o.rollbackFloor === 'string' && o.rollbackFloor ? o.rollbackFloor : ROLLBACK_FLOOR_VERSION;
  if (semverCompare(version, floor) < 0) return false;
  const maxAgeDays = typeof o.rollbackMaxAgeDays === 'number' ? o.rollbackMaxAgeDays : ROLLBACK_MAX_AGE_DAYS;
  const t = meta && meta.time && typeof meta.time === 'object' ? meta.time[version] : null;
  const publishedAt = typeof t === 'string' ? Date.parse(t) : NaN;
  if (Number.isFinite(publishedAt)) {
    const now = typeof o.now === 'number' ? o.now : Date.now();
    if (now - publishedAt > maxAgeDays * 86400000) return false;
  }
  return true;
}

function isOurBetaRelease(v) { return /-BETA\./.test(String(v)); }

function highestVersion(candidates, isValid) {
  let best = null;
  for (const v of candidates) {
    if (!isValid(v)) continue;
    if (best === null || semverCompare(v, best) > 0) best = v;
  }
  return best;
}

function pickReleaseVersion(meta, opts) {
  const o = opts || {};
  const isValid = typeof o.isValid === 'function' ? o.isValid : (v) => typeof v === 'string' && v.length > 0;
  const tags = (meta && meta['dist-tags']) || {};
  const versionKeys = (meta && meta.versions && typeof meta.versions === 'object') ? Object.keys(meta.versions) : [];
  const validTag = (v) => (typeof v === 'string' && isValid(v) ? v : null);

  if (o.isOurs === true) {
    const rollback = validTag(tags.rollback);
    if (rollback && rollbackAllowed(rollback, meta, o)) return rollback;
    if (o.canary === true) {
      const canary = validTag(tags.canary);
      if (canary) return canary;
    }
    const latest = validTag(tags.latest);
    if (latest) return latest;
    return highestVersion(versionKeys.filter((v) => !isOurBetaRelease(v)), isValid);
  }

  const thirdLatest = validTag(tags.latest);
  if (thirdLatest) return thirdLatest;
  return highestVersion(versionKeys, isValid);
}

module.exports = {
  OUR_RELEASE_SCOPE,
  ROLLBACK_FLOOR_VERSION,
  ROLLBACK_MAX_AGE_DAYS,
  isOurReleasePackage,
  highestVersion,
  pickReleaseVersion,
};
