'use strict';
const path = require('node:path');
const {spawn} = require('node:child_process');
const {checkSetup, parseArgs} = require('./check-setup.cjs');
try {
  const options = parseArgs(process.argv.slice(2));
  const patch = options.mode === 'patch';
  options.generate = options.flow === 'repair' && !patch;
  const report = checkSetup(options);
  if (!report.ready) {
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } else {
    const root = path.resolve(__dirname, '..');
    const env = {...process.env};
    if (options.flow === 'repair') {
      env.REPAIR_SANDBOX_DIR ||= env.NEAR_SANDBOX_BIN_PATH;
    }
    const child = spawn(process.execPath, [path.join(root, 'ui/sputnik/server.cjs')], {cwd: root, env, stdio: 'inherit'});
    child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', (code) => { process.exitCode = code ?? 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    console.log(`Open http://127.0.0.1:${env.PORT || 4174}${patch ? '/repair?mode=patch' : options.flow === 'repair' ? '/repair' : '/'}`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
