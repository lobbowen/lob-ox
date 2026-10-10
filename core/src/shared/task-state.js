'use strict';

function taskStateToView(s) {
  return (s === 'succeeded' || s === 'skipped') ? 'done' : (s === 'failed' || s === 'canceled') ? 'failed' : 'running';
}

module.exports = { taskStateToView };
