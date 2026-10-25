// Three-way merge: independent edits combine; overlapping prose becomes a visible copy.
export function sharedWorkspace(state) {
  return { version: 1, workspaceName: state.workspaceName, documents: state.documents, agents: state.agents, selectedId: null, expanded: [] };
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function mergeWorkspace(remote, base, local, makeId = () => crypto.randomUUID()) {
  const result = structuredClone(remote), conflicts = [];
  if (local.workspaceName !== base.workspaceName) result.workspaceName = local.workspaceName;
  for (const [collection, fields] of [['documents', ['title', 'content', 'parentId']], ['agents', ['name', 'memory']]]) {
    const before = new Map(base[collection].map(item => [item.id, item]));
    const after = new Map(local[collection].map(item => [item.id, item]));
    for (const [id, old] of before) {
      if (after.has(id)) continue;
      const current = result[collection].find(item => item.id === id);
      if (!current) continue;
      if (fields.every(key => equal(current[key], old[key]))) result[collection] = result[collection].filter(item => item.id !== id);
      else conflicts.push('另一端修改过的内容已保留，未删除');
    }
    for (const [id, desired] of after) {
      const old = before.get(id);
      const changed = fields.filter(key => !old || !equal(desired[key], old[key]));
      if (!changed.length) continue;
      const current = result[collection].find(item => item.id === id);
      if (!old && !current) { result[collection].push(structuredClone(desired)); continue; }
      // Deleting a companion wins over edits from an already-open dialog/tab.
      if (collection === 'agents' && old && !current) { conflicts.push('该伙伴存档已删除，未重新创建'); continue; }
      const collision = !current || changed.some(key => !equal(current[key], old?.[key]) && !equal(current[key], desired[key]));
      if (collision) {
        const copy = { ...structuredClone(desired), id: makeId() };
        if (collection === 'documents') { copy.title += '（本机冲突副本）'; copy.revision = 1; }
        else { copy.name += '（本机冲突副本）'; }
        result[collection].push(copy);
        conflicts.push(`「${desired.title || desired.name}」发生同时编辑，已保留两份`);
      } else {
        for (const key of changed) current[key] = desired[key];
        if (desired.updatedAt) current.updatedAt = desired.updatedAt;
      }
    }
  }
  const ids = new Set(result.documents.map(d => d.id));
  for (const doc of result.documents) if (!ids.has(doc.parentId)) doc.parentId = null;
  return { workspace: result, conflicts };
}
