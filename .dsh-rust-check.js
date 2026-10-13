// Rust-aware bracket-balance self-check for hand-edited .rs files.
// Handles: nested block comments, line comments, "..." strings, r".."/r#".."# raw
// strings, b"..", b'..' char literals, and 'a lifetimes (vs 'x' char literals).
// Usage: node .dsh-rust-check.js <file.rs> [more.rs ...]
const fs = require("node:fs");

function checkBalance(src) {
  const out = { ok: true, errors: [] };
  const stack = [];
  const pairs = { ")": "(", "]": "[", "}": "{" };
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (src[i] === "\n") line++;
        if (src[i] === "/" && src[i + 1] === "*") { depth++; i += 2; continue; }
        if (src[i] === "*" && src[i + 1] === "/") { depth--; i += 2; continue; }
        i++;
      }
      if (depth > 0) out.errors.push("line " + line + ": unterminated block comment");
      continue;
    }
    if ((c === "r" || c === "c" || c === "b") && (src[i + 1] === '"' || src[i + 1] === "#")) {
      let j = i + 1; let hashes = 0;
      while (src[j] === "#") { hashes++; j++; }
      if (src[j] === '"') {
        j++;
        let closed = false;
        while (j < n) {
          if (src[j] === '"') {
            let k = j + 1; let h = 0;
            while (k < n && src[k] === "#" && h < hashes) { h++; k++; }
            if (h === hashes) { j = k; closed = true; break; }
          }
          if (src[j] === "\n") line++;
          j++;
        }
        if (!closed) out.errors.push("line " + line + ": unterminated raw string");
        i = j; continue;
      }
    }
    if (c === "b" && src[i + 1] === '"') { i += 2; while (i < n && src[i] !== '"') { if (src[i] === "\\") i++; if (src[i] === "\n") line++; i++; } i++; continue; }
    if (c === "b" && src[i + 1] === "'") { i += 2; while (i < n && src[i] !== "'") { if (src[i] === "\\") i++; i++; } i++; continue; }
    if (c === '"') {
      i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        if (src[i] === "\n") { line++; out.errors.push("line " + (line - 1) + ": newline inside normal string"); }
        i++;
      }
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      if (j < n && src[j] === "\\") { j += 2; while (j < n && src[j] !== "'") j++; j++; }
      else if (j + 1 < n && src[j + 1] === "'") { j += 2; }
      if (j < n && src[j] === "'") { i = j + 1; continue; }
      i = i + 1;
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) i++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") { stack.push({ c: c, line: line }); i++; continue; }
    if (c === ")" || c === "]" || c === "}") {
      const top = stack.pop();
      if (!top || top.c !== pairs[c]) {
        out.errors.push("line " + line + ": unexpected '" + c + "'" + (top ? " (opened '" + top.c + "' at line " + top.line + ")" : ""));
      }
      i++; continue;
    }
    i++;
  }
  for (const s of stack) out.errors.push("line " + s.line + ": unclosed '" + s.c + "'");
  out.ok = out.errors.length === 0;
  return out;
}

const files = process.argv.slice(2);
if (files.length === 0) { console.error("usage: node .dsh-rust-check.js <file.rs> ..."); process.exit(2); }
const report = {};
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const r = checkBalance(src);
  report[f] = { ok: r.ok, errors: r.errors };
  if (!r.ok) bad++;
}
console.log(JSON.stringify(report, null, 2));
if (bad > 0) process.exit(1);
