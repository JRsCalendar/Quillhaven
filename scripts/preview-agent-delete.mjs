// Isolated UI fixture: no user data and no model calls.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';
import { initialState, createDocument } from '../dist/store.js';
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'quillhaven-delete-preview-'));
const app = createAppServer({ dataDir, port: 5175, automatic: false });
const state = initialState();
state.workspaceName = '你的世界';
createDocument(state, '世界观');
state.agents = [{ id: 'disposable-preview-agent', name: '测试伙伴', memory: '仅用于验证存档管理界面。' }];
app.store.migrate({ id: 'delete-ui-fixture', workspace: state, messages: [] });
await app.listen();
console.log('隔离预览：http://127.0.0.1:5175');
let closed = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closed) return;
  closed = true;
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});
