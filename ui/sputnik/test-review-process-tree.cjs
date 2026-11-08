'use strict';
/*
 * A review runs as a process group leader because the review script starts the
 * pipeline, Cargo and Sandbox as descendants. Signalling only the top-level PID
 * leaves those building and replaying, so this exercises the real process tree:
 * parent and grandchild share a group, both ignore SIGTERM, and the escalation
 * to SIGKILL must take the whole group down.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {createManager, exampleBundleText, killTree} = require('./review-job.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'near-review-tree-'));
const grandchildPidFile = path.join(tmp, 'grandchild.pid');
const parentPidFile = path.join(tmp, 'parent.pid');

const grandchildSource = `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

const parentSource = `
const {spawn} = require('node:child_process');
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid));
spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {stdio: 'ignore'});
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readPid = async (file, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const value = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isInteger(value) && value > 0) return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path.basename(file)}`);
};

const pgid = (pid) => {
  const out = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], {encoding: 'utf8'});
  return out.status === 0 ? Number(out.stdout.trim()) : NaN;
};


const waitDead = async (pid, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} is still alive after ${timeoutMs}ms`);
};

async function managerTreeCase(kind) {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), `near-review-${kind}-runs-`));
  const pidRoot = fs.mkdtempSync(path.join(os.tmpdir(), `near-review-${kind}-pids-`));
  const sandbox = path.join(runRoot, 'sandbox');
  fs.mkdirSync(sandbox, {recursive: true});
  fs.writeFileSync(path.join(sandbox, 'near-sandbox'), '');
  const parentPidFile = path.join(pidRoot, 'parent.pid');
  const grandchildPidFile = path.join(pidRoot, 'grandchild.pid');
  const termFile = path.join(pidRoot, 'term-observed');
  const grandchild = `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid));
    process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(termFile)}, 'grandchild'));
    setInterval(() => {}, 1000);
  `;
  const parent = `
    const {spawn} = require('node:child_process');
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid));
    spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio: 'ignore'});
    process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(termFile)}, 'parent'));
    setInterval(() => {}, 1000);
  `;
  const manager = createManager({
    runsRoot: runRoot,
    env: {REPAIR_SANDBOX_DIR: sandbox},
    runLimitMs: 120,
    killGraceMs: 80,
    spawn: (command, args, options) => spawn(process.execPath, ['-e', parent], options),
  });
  const started = manager.start(exampleBundleText().bundle, 'recorded-wasm');
  const parentPid = await readPid(parentPidFile);
  const grandchildPid = await readPid(grandchildPidFile);
  assert.equal(pgid(grandchildPid), parentPid, `${kind}: descendant shares the review group`);
  try {
    if (kind === 'timeout') {
      await manager.get(started.id).done;
    } else {
      await manager.shutdown();
    }
    await waitDead(parentPid);
    await waitDead(grandchildPid);
    assert.ok(fs.existsSync(termFile), `${kind}: the group received TERM before escalation`);
    const run = manager.get(started.id);
    assert.equal(run.status, 'interrupted', `${kind}: stopped run is interrupted`);
    assert.match(run.error, kind === 'timeout' ? /limit/ : /server shut down/, `${kind}: reason is recorded`);
    assert.equal(manager.active(), null, `${kind}: no review remains active`);
    console.log(`review-process-tree: ${kind} terminates the group, including an orphaned descendant`);
  } finally {
    for (const pid of [grandchildPid, parentPid]) {
      if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    fs.rmSync(runRoot, {recursive: true, force: true});
    fs.rmSync(pidRoot, {recursive: true, force: true});
  }
}

(async () => {
  try {
    await managerTreeCase('timeout');
    await managerTreeCase('shutdown');
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

(async () => {
  const children = [];
  try {
    const parent = spawn(process.execPath, ['-e', parentSource], {detached: true, stdio: 'ignore'});
    children.push(parent);
    const parentPid = await readPid(parentPidFile);
    const grandchildPid = await readPid(grandchildPidFile);
    children.push({pid: grandchildPid});

    assert.equal(parentPid, parent.pid, 'reported parent PID matches the spawned process');
    assert.equal(pgid(grandchildPid), parent.pid, 'descendant inherits the review process group');
    assert.equal(alive(grandchildPid), true, 'descendant is running');

    killTree(parent, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(alive(grandchildPid), true, 'a SIGTERM-ignoring descendant survives the first signal');

    killTree(parent, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(alive(parentPid), false, 'the process group leader is gone');
    assert.equal(alive(grandchildPid), false, 'the descendant is gone after escalation, not orphaned');

    console.log('review-process-tree: SIGTERM plus escalation terminates descendants, not just the leader');
  } finally {
    for (const child of children) {
      if (child && alive(child.pid)) {
        try { process.kill(child.pid, 'SIGKILL'); } catch {}
      }
    }
    fs.rmSync(tmp, {recursive: true, force: true});
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
