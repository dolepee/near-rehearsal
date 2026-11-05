(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RehearsalPoller = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  async function pollUntilTerminal({fetchRun, onRun, onError, shouldStop, delayMs = 1400, sleep} = {}) {
    if (typeof fetchRun !== 'function') throw new Error('fetchRun is required');
    const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    try {
      while (true) {
        if (shouldStop?.()) return null;
        const run = await fetchRun();
        onRun?.(run);
        if (!run || run.status !== 'running') return run;
        // Keep polling after every running response. A completed run must stop
        // the loop without relying on a page reload.
        await wait(delayMs);
      }
    } catch (error) {
      onError?.(error);
      return null;
    }
  }
  return {pollUntilTerminal};
});
