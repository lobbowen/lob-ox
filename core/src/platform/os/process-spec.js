'use strict';

const input = require('../util/input');

const IGNORE_SCRIPTS_FLAG = '--ignore-scripts';
const NO_IGNORE_SCRIPTS_FLAG = '--no-ignore-scripts';

const ENV_PASSTHROUGH = [
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP',
  'SystemRoot', 'SystemDrive', 'COMSPEC', 'PATHEXT',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles',
  'LANG', 'LC_ALL', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

function defaultSpec() {
  return {
    runtime: null,      
    bin: null,          
    subcommand: null,   
    args: [],           
    port: null,         
    patchFile: null,    
    storeDir: null,     
    install: false,     
    extraFlags: [],     
  };
}

function validate(spec) {
  const errs = [];
  const check = (v, what) => {
    if (v === null || v === undefined) return;
    const s = String(v);
    if (input.ARGV_UNSAFE_RE.test(s)) errs.push(what + ' 含 argv 禁用字符: ' + s.slice(0, 40));
    if (s.indexOf('..') >= 0) errs.push(what + ' 含路径遍历形态: ' + s.slice(0, 40));
  };
  check(spec.bin, 'bin');
  check(spec.runtime, 'runtime');
  check(spec.subcommand, 'subcommand');
  check(spec.patchFile, 'patchFile');
  check(spec.storeDir, 'storeDir');
  for (const a of spec.args || []) check(a, 'arg');
  if (spec.port !== null && spec.port !== undefined) {
    const p = Number(spec.port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) errs.push('非法端口: ' + spec.port);
  }
  return errs;
}

function build(specIn) {
  const spec = Object.assign(defaultSpec(), specIn || {});
  const errs = validate(spec);
  if (errs.length) return { ok: false, error: errs.join('; '), argv: null };

  const out = [];
  if (spec.runtime) out.push(spec.runtime);
  if (spec.bin) out.push(spec.bin);
  if (spec.subcommand) out.push(spec.subcommand);

  for (const f of spec.extraFlags || []) out.push(f);
  if (spec.storeDir) out.push('--store-dir', String(spec.storeDir));

  
  const args = [];
  const rawArgs = spec.args || [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const a = String(rawArgs[i]);
    if (a === '--port' || a === '-p') { i += 1; continue; }   
    if (/^--port=/.test(a)) continue;
    args.push(a);
  }

  if (spec.port !== null && spec.port !== undefined) out.push('--port', String(spec.port));
  if (spec.patchFile) out.push('--patch', String(spec.patchFile));
  for (const a of args) out.push(a);

  
  
  const lowered = out.map((x) => String(x));
  if (spec.install && lowered.indexOf(IGNORE_SCRIPTS_FLAG) < 0 && lowered.indexOf(NO_IGNORE_SCRIPTS_FLAG) < 0) {
    out.push(IGNORE_SCRIPTS_FLAG);
  }
  return { ok: true, error: null, argv: out };
}

function childEnv(targetEnv, registryEnv) {
  const out = {};
  for (const k of ENV_PASSTHROUGH) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  if (targetEnv) Object.assign(out, targetEnv);
  if (registryEnv) Object.assign(out, registryEnv);
  return out;
}

module.exports = {
  IGNORE_SCRIPTS_FLAG, NO_IGNORE_SCRIPTS_FLAG, ENV_PASSTHROUGH,
  defaultSpec, validate, build, childEnv,
};
