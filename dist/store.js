export const STORAGE_KEY = 'quillhaven.workspace.v1';
export const DEFAULT_WORKSPACE_NAME = '你的世界';
export const makeId = () => globalThis.crypto.randomUUID();
export function initialState() {
  return { version: 1, workspaceName: DEFAULT_WORKSPACE_NAME, documents: [], agents: [], selectedId: null, expanded: [] };
}
export function createDocument(state, title, parentId = null) {
  if (parentId && !state.documents.some(d => d.id === parentId)) throw new Error('父文档不存在');
  const now = new Date().toISOString();
  const doc = { id: makeId(), parentId, title: title.trim() || '未命名', content: '', createdAt: now, updatedAt: now };
  state.documents.push(doc);
  state.selectedId = doc.id;
  if (parentId && !state.expanded.includes(parentId)) state.expanded.push(parentId);
  return doc;
}
export function descendants(state, id) {
  const ids = new Set([id]);
  let previous;
  do {
    previous = ids.size;
    state.documents.forEach(d => { if (ids.has(d.parentId)) ids.add(d.id); });
  } while (previous !== ids.size);
  return ids;
}
export function deleteDocument(state, id) {
  const ids = descendants(state, id);
  state.documents = state.documents.filter(d => !ids.has(d.id));
  state.expanded = state.expanded.filter(key => !ids.has(key));
  if (ids.has(state.selectedId)) state.selectedId = null;
}
export function parseState(raw) {
  if (!raw) return initialState();
  const s = JSON.parse(raw);
  if (s.version !== 1 || !Array.isArray(s.documents) || !Array.isArray(s.agents) || !Array.isArray(s.expanded)) throw new Error('不支持的存档格式');
  const ids = new Set();
  for (const d of s.documents) {
    if (typeof d.id !== 'string' || ids.has(d.id) || typeof d.title !== 'string' || typeof d.content !== 'string' || typeof d.createdAt !== 'string' || typeof d.updatedAt !== 'string') throw new Error('文档数据不完整');
    ids.add(d.id);
  }
  for (const d of s.documents) {
    const seen = new Set([d.id]);
    let parent = d.parentId;
    while (parent !== null) {
      if (seen.has(parent) || !ids.has(parent)) throw new Error('文档层级无效');
      seen.add(parent);
      parent = s.documents.find(item => item.id === parent).parentId;
    }
  }
  const agentIds = new Set();
  for (const a of s.agents) {
    if (typeof a.id !== 'string' || agentIds.has(a.id) || typeof a.name !== 'string' || typeof a.memory !== 'string') throw new Error('Agent 存档无效');
    agentIds.add(a.id);
  }
  const workspaceName = typeof s.workspaceName === 'string' ? s.workspaceName.trim().slice(0, 40) || DEFAULT_WORKSPACE_NAME : DEFAULT_WORKSPACE_NAME;
  return { version: 1, workspaceName, documents: s.documents, agents: s.agents.map(({ id, name, memory }) => ({ id, name, memory })), selectedId: ids.has(s.selectedId) ? s.selectedId : null, expanded: s.expanded.filter(id => ids.has(id)) };
}
export function wordCount(text) {
  return (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+/gu) || []).length;
}
