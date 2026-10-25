import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, createDocument, deleteDocument, parseState, wordCount } from '../dist/store.js';

test('legacy workspaces keep all documents and acquire a renameable workspace name', () => {
  const legacy = initialState();
  const doc = createDocument(legacy, '既有设定');
  doc.content = '保留原有正文';
  delete legacy.workspaceName;
  const restored = parseState(JSON.stringify(legacy));
  assert.equal(restored.workspaceName, '你的世界');
  assert.deepEqual(restored.documents, legacy.documents);
  restored.workspaceName = '星海纪事';
  assert.equal(parseState(JSON.stringify(restored)).workspaceName, '星海纪事');
});

test('nested documents survive reload, and deleting a branch preserves other roots', () => {
  const s = initialState();
  const world = createDocument(s, '世界观');
  const kingdom = createDocument(s, '王国', world.id);
  const history = createDocument(s, '历史', kingdom.id);
  history.content = '很久以前，一个故事开始了。';
  const other = createDocument(s, '人物');
  const restored = parseState(JSON.stringify(s));
  assert.equal(restored.documents.find(d => d.id === history.id).content, history.content);
  assert.ok(restored.expanded.includes(world.id));
  assert.ok(restored.expanded.includes(kingdom.id));
  deleteDocument(restored, kingdom.id);
  assert.deepEqual(restored.documents.map(d => d.id), [world.id, other.id]);
  assert.equal(restored.selectedId, other.id);
});
test('agent memories survive reload but persisted connection status is discarded', () => {
  const s = initialState();
  s.agents.push({ id: 'dragon', name: '龙娘', memory: '保持温柔的叙事风格', online: true });
  const restored = parseState(JSON.stringify(s));
  assert.equal(restored.agents[0].memory, '保持温柔的叙事风格');
  assert.equal(restored.agents[0].online, undefined);
});
test('invalid or cyclic saved trees are rejected before rendering', () => {
  const s = initialState();
  const a = createDocument(s, 'A');
  const b = createDocument(s, 'B', a.id);
  a.parentId = b.id;
  assert.throws(() => parseState(JSON.stringify(s)), /层级无效/);
  assert.throws(() => parseState('{bad json'));
});
test('deleting active ancestor clears selection and counts mixed Chinese / English text', () => {
  const s = initialState();
  const a = createDocument(s, 'A');
  createDocument(s, 'B', a.id);
  deleteDocument(s, a.id);
  assert.equal(s.selectedId, null);
  assert.equal(wordCount('世界 hello world，123'), 5);
});
