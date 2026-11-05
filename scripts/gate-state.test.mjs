import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resetGateState } from '../tests/gates/gate-state.mjs';

test('门禁重置拒绝生产标识，保留旧数据并隔离每轮快照', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ziedit-gate-state-'));
  try {
    assert.throws(() => resetGateState('dev.ziedit.app', root, root));
    assert.deepEqual(fs.readdirSync(root), []);
    const id = 'dev.ziedit.gates.r0123456789ab';
    const first = resetGateState(id, path.join(root, 'run'), root);
    fs.writeFileSync(path.join(first.directory, 'session.json'), '{"old":true}');
    const second = resetGateState(id, path.join(root, 'run'), root);
    assert.notEqual(first.settings.snapshotDir, second.settings.snapshotDir);
    assert.equal(fs.readFileSync(path.join(second.history, 'session.json'), 'utf8'), '{"old":true}');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(second.directory, 'session.json'))).tabs, []);
  } finally { fs.rmSync(root, { recursive: true }); }
});
