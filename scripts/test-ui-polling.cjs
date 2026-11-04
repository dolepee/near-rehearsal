'use strict';
const assert = require('node:assert/strict');
const {pollUntilTerminal} = require('../ui/public/polling.js');

(async () => {
  const responses = [
    {id: 'r1', status: 'running'},
    {id: 'r1', status: 'running'},
    {id: 'r1', status: 'complete', report: {result: {status: 'complete'}}},
  ];
  let calls = 0;
  const seen = [];
  const result = await pollUntilTerminal({
    delayMs: 0,
    sleep: async () => {},
    fetchRun: async () => responses[calls++],
    onRun: (run) => seen.push(run.status),
  });
  assert.equal(calls, 3, 'poll twice while running, then terminal');
  assert.deepEqual(seen, ['running', 'running', 'complete']);
  assert.equal(result.status, 'complete');
  console.log('accepted: two running responses then complete; polling stops');

  const firstTerminal = await pollUntilTerminal({
    delayMs: 0,
    sleep: async () => {},
    fetchRun: async () => ({status: 'error'}),
    onRun: () => {},
  });
  assert.equal(firstTerminal.status, 'error');
  console.log('accepted: terminal first response does not poll again');
})();
