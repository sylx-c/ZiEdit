import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertInside, writeJson } from '../../scripts/build-provenance.mjs';

/** 每项门禁从空会话和相同设置开始；仅操作隔离标识的数据，旧数据留作证据。 */
export function resetGateState(identifier, runDir, appData = process.env.APPDATA) {
  if (!/^dev\.ziedit\.gates\.r[0-9a-f]{12}$/.test(identifier) || !appData) throw new Error('Not an isolated Windows gate application');
  const directory = path.join(appData, identifier);
  assertInside(appData, directory);
  const history = path.join(runDir, 'state-history', crypto.randomUUID());
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(history, { recursive: true });
  for (const name of ['session.json', 'settings.json', 'recent.json']) {
    const file = path.join(directory, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(history, name));
  }
  const settings = { mdDefaultMode: 'preview', readOnlyMode: false, autoSaveSec: 0,
    snapshotDir: path.join(history, 'snapshots'), language: 'zh-CN' };
  writeJson(path.join(directory, 'session.json'), { tabs: [], activeIndex: -1 });
  writeJson(path.join(directory, 'settings.json'), settings);
  writeJson(path.join(directory, 'recent.json'), []);
  return { directory, history, settings };
}
