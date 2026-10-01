'use strict';

function deriveCmdMarks(script, cmdMark) {
  const norm = (s) => String(s || '').replace(/\\/g, '/');
  const marks = [];
  if (cmdMark) marks.push(String(cmdMark));
  if (script) {
    marks.push(norm(script));
    const m = /[/\\](src[/\\][^\s]+|domains[/\\][^\s]+)$/.exec(norm(script));
    if (m) marks.push(m[1]);
  }
  return marks;
}

module.exports = { deriveCmdMarks };
