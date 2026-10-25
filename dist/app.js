import { STORAGE_KEY, DEFAULT_WORKSPACE_NAME, initialState, parseState, createDocument, deleteDocument, descendants, wordCount, makeId } from './store.js';
import { setupChat } from './chat.js';
import { setupLineNumbers } from './line-numbers.js';
import { initializeWorkspace, startWorkspaceSync, api } from './local-api.js';
import { mergeWorkspace } from './workspace-merge.js';
import { setupAutomatic } from './automatic.js';

const $ = selector => document.querySelector(selector);
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  files: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z"/><path d="M14 3v5h5M8 12h8M8 16h6"/>',
  branch: '<path d="M6 3v12a3 3 0 0 0 3 3h9M6 8h12"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  feather: '<path d="M20 3c-8-1-16 5-14 13l4 1c7-1 11-7 10-14Z"/><path d="m3 22 12-13M6 16h6"/>',
  edit: '<path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
  moon: '<path d="M20.5 13A9 9 0 0 1 11 3.5 9 9 0 1 0 20.5 13Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8ZM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  chat: '<path d="M21 11a9 8 0 0 1-9 8 11 11 0 0 1-4-1l-5 3 1-6a8 8 0 0 1-1-4 9 8 0 0 1 18 0Z"/>',
  sparkles: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4ZM20 2v4m-2-2h4"/>',
  archive: '<rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v13h14V8M10 12h4"/>',
  link: '<path d="m10 8 3-3a4 4 0 0 1 6 6l-3 3M14 16l-3 3a4 4 0 0 1-6-6l3-3m0 6 8-8"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>'
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`; }
document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
let state;
let loadError = false;
try { state = parseState(localStorage.getItem(STORAGE_KEY)); } catch { state = initialState(); loadError = true; }
let sync;
document.querySelector('.app-shell').inert = true;
try {
  if (loadError) throw new Error('原有浏览器存档读取失败，已保留原始数据。');
  $('#save-status').textContent = '正在连接本机数据库…';
  const packet = await initializeWorkspace(state);
  state = packet.workspace;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  document.querySelector('.app-shell').inert = false;
} catch (error) {
  $('#save-status').textContent = '连接失败';
  const warning = document.createElement('div'); warning.className = 'boot-error';
  const message = document.createElement('p'); message.textContent = `暂时无法打开工作空间：${error.message} 原始存档已保留。请确认本机服务正在运行。`;
  const retry = document.createElement('button'); retry.className = 'primary-button'; retry.textContent = '重新连接'; retry.onclick = () => location.reload();
  warning.append(message, retry); document.body.append(warning);
  throw error;
}
const onlineAgents = new Set();
let openedId = state.selectedId;
let inlineEdit = null;
let menuDocumentId = null;
let pendingDeleteId = null;
let editingAgentId = null;
let agentDialogBase;
let pendingAgentDeleteId = null;
let deletingAgent = false;
let pendingTreeRefresh = false;
let toastTimer;
let connectorFrame;
let chat;
let automatic;
const lineNumbers = setupLineNumbers($('#document-content'), $('#line-gutter'), $('#line-measure'));

function syncDocumentConnector() {
  const connector = $('#document-connector');
  const row = $('#document-tree .tree-row.selected');
  const drawer = $('#document-drawer');
  if (!row || !openedId || !drawer.classList.contains('open') || document.body.classList.contains('sidebar-hidden') || window.matchMedia('(max-width:600px)').matches) {
    connector.classList.add('hidden'); return;
  }
  const rect = row.getBoundingClientRect();
  const viewport = $('.tree-scroll').getBoundingClientRect();
  const pane = $('.writing-pane').getBoundingClientRect();
  const center = rect.top + rect.height / 2;
  // Never point to a filtered, collapsed, or scrolled-out document.
  if (center - 10 < Math.max(viewport.top, pane.top) || center + 10 > Math.min(viewport.bottom, pane.bottom)) {
    connector.classList.add('hidden'); return;
  }
  // Keep the whole tail outside the scroll container, including its scrollbar.
  const left = Math.max(pane.left - 11, viewport.right + 3);
  const width = pane.left + 1 - left;
  if (width < 4) { connector.classList.add('hidden'); return; }
  connector.style.left = `${left}px`;
  connector.style.top = `${center - 10}px`;
  connector.style.width = `${width}px`;
  connector.classList.remove('hidden');
}
function scheduleConnector() {
  cancelAnimationFrame(connectorFrame);
  connectorFrame = requestAnimationFrame(syncDocumentConnector);
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3200);
}
function persist() {
  try {
    if (loadError) throw new Error('原有存档读取失败，请先保留原始数据');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    sync?.queue();
    return true;
  } catch {
    $('#save-status').textContent = '未保存 · 请导出备份';
    return false;
  }
}
const currentDocument = () => state.documents.find(d => d.id === openedId);
function renderTree() {
  finishInlineName();
  const tree = $('#document-tree');
  tree.replaceChildren();
  $('#document-count').textContent = state.documents.length;
  $('#tree-empty').classList.toggle('hidden', state.documents.length > 0);
  const query = $('#search').value.trim().toLocaleLowerCase();
  const visible = new Set();
  if (query) {
    state.documents.filter(d => d.title.toLocaleLowerCase().includes(query)).forEach(d => {
      let item = d;
      while (item) { visible.add(item.id); item = state.documents.find(parent => parent.id === item.parentId); }
    });
  }
  $('#no-results').classList.toggle('hidden', !query || visible.size > 0 || !state.documents.length);
  function appendChildren(parentId, container, level) {
    for (const doc of state.documents.filter(d => d.parentId === parentId)) {
      if (query && !visible.has(doc.id)) continue;
      const children = state.documents.some(d => d.parentId === doc.id);
      const expanded = !!query || state.expanded.includes(doc.id);
      const item = document.createElement('div');
      item.setAttribute('role', 'treeitem');
      item.setAttribute('aria-selected', String(doc.id === openedId));
      item.setAttribute('aria-label', doc.title);
      item.setAttribute('aria-level', String(level + 1));
      if (children) item.setAttribute('aria-expanded', String(expanded));
      const row = document.createElement('div');
      row.dataset.documentId = doc.id;
      row.className = 'tree-row' + (doc.id === openedId ? ' selected' : '');
      row.style.paddingLeft = `${level * 16 + 2}px`;
      const toggle = document.createElement('button');
      toggle.className = 'toggle' + (expanded ? ' open' : '');
      toggle.disabled = !children;
      toggle.innerHTML = icon('chevron');
      toggle.setAttribute('aria-label', `${expanded ? '折叠' : '展开'} ${doc.title}`);
      toggle.onclick = () => {
        state.expanded = expanded ? state.expanded.filter(id => id !== doc.id) : [...state.expanded, doc.id];
        persist(); renderTree();
        [...tree.querySelectorAll('.toggle')].find(el => el.getAttribute('aria-label') === `${expanded ? '展开' : '折叠'} ${doc.title}`)?.focus();
      };
      const file = document.createElement('button');
      file.className = 'tree-file';
      file.title = doc.title;
      file.innerHTML = icon('files');
      const name = document.createElement('span');
      name.className = 'tree-name'; name.textContent = doc.title;
      file.append(name);
      file.onclick = () => openDocument(doc.id, true);
      file.ondblclick = () => beginInlineName(doc.id);
      file.onkeydown = event => {
        if (event.key === 'F2') { event.preventDefault(); beginInlineName(doc.id); }
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault(); const rect = row.getBoundingClientRect(); showDocumentMenu(doc.id, rect.left + 25, rect.bottom);
        }
      };
      const rename = document.createElement('button');
      rename.className = 'icon-button tree-rename';
      rename.innerHTML = icon('edit');
      rename.setAttribute('aria-label', `改名 ${doc.title}`);
      rename.title = '改名';
      rename.onclick = () => beginInlineName(doc.id);
      const add = document.createElement('button');
      add.className = 'icon-button tree-add';
      add.innerHTML = icon('plus');
      add.setAttribute('aria-label', `在 ${doc.title} 下新建文档`);
      add.title = '新建子文档';
      add.onclick = () => newInlineDocument(doc.id);
      row.oncontextmenu = event => { event.preventDefault(); showDocumentMenu(doc.id, event.clientX, event.clientY); };
      row.append(toggle, file, rename, add); item.append(row); container.append(item);
      if (children && expanded) {
        const group = document.createElement('div'); group.className = 'tree-group'; group.setAttribute('role', 'group');
        item.append(group); appendChildren(doc.id, group, level + 1);
      }
    }
  }
  appendChildren(null, tree, 0);
  scheduleConnector();
}
function renderBreadcrumb(doc) {
  const titles = [doc.title];
  let parent = state.documents.find(d => d.id === doc.parentId);
  while (parent) { titles.unshift(parent.title); parent = state.documents.find(d => d.id === parent.parentId); }
  const breadcrumb = $('#breadcrumb'); breadcrumb.replaceChildren();
  [state.workspaceName, ...titles].forEach((title, i) => {
    if (i) { const separator = document.createElement('span'); separator.textContent = '/'; breadcrumb.append(separator); }
    breadcrumb.append(document.createTextNode(title));
  });
}
let originalWorkspaceName = state.workspaceName;
function renderWorkspaceName() {
  $('#workspace-name').textContent = state.workspaceName;
  $('#workspace-name-button').title = `${state.workspaceName} · 点击修改目录名称`;
  $('#document-tree').setAttribute('aria-label', `${state.workspaceName}文档树`);
  const doc = currentDocument();
  if (doc) renderBreadcrumb(doc);
}
function saveWorkspaceName() {
  state.workspaceName = $('#workspace-name-input').value.trim() || DEFAULT_WORKSPACE_NAME;
  persist(); renderWorkspaceName();
}
function finishWorkspaceName(cancel = false) {
  if ($('#workspace-name-input').classList.contains('hidden')) return;
  if (cancel) $('#workspace-name-input').value = originalWorkspaceName;
  saveWorkspaceName();
  $('#workspace-name-input').classList.add('hidden');
  $('#workspace-name-button').classList.remove('hidden');
}
$('#workspace-name-button').onclick = () => {
  originalWorkspaceName = state.workspaceName;
  $('#workspace-name-input').value = state.workspaceName;
  $('#workspace-name-button').classList.add('hidden');
  $('#workspace-name-input').classList.remove('hidden');
  $('#workspace-name-input').focus(); $('#workspace-name-input').select();
};
$('#workspace-name-input').oninput = saveWorkspaceName;
$('#workspace-name-input').onblur = () => finishWorkspaceName();
$('#workspace-name-input').onkeydown = event => {
  if (event.isComposing) return;
  if (event.key === 'Enter' || event.key === 'Escape') {
    event.preventDefault(); finishWorkspaceName(event.key === 'Escape'); $('#workspace-name-button').focus();
  }
};
renderWorkspaceName();
function openDocument(id, animate = false) {
  const doc = state.documents.find(d => d.id === id); if (!doc) return;
  openedId = id; state.selectedId = id; persist();
  const drawer = $('#document-drawer');
  $('#document-connector').classList.add('hidden');
  if (animate && drawer.classList.contains('open')) {
    drawer.classList.remove('open');
    drawer.style.transition = 'none';
    void drawer.offsetWidth;
    drawer.style.transition = '';
  }
  drawer.inert = false;
  $('#chat-view').inert = true;
  $('#chat-view').setAttribute('aria-hidden', 'true');
  $('#document-content').value = doc.content;
  $('#document-content').setSelectionRange(0, 0);
  $('#document-content').scrollTop = 0;
  lineNumbers.update();
  renderUpdatedAt(doc);
  $('#word-count').textContent = `${wordCount(doc.content).toLocaleString()} 字`;
  renderBreadcrumb(doc); renderTree();
  requestAnimationFrame(() => { drawer.classList.add('open'); scheduleConnector(); });
  if (window.matchMedia('(max-width:600px)').matches) setSidebar(false);
}
function closeDocument() {
  $('#document-connector').classList.add('hidden');
  $('#document-drawer').classList.remove('open');
  $('#document-drawer').inert = true;
  $('#chat-view').inert = false;
  $('#chat-view').removeAttribute('aria-hidden');
  openedId = null; state.selectedId = null; persist(); renderTree();
  $('#chat-input').focus();
}
function renderUpdatedAt(doc) {
  $('#document-date').dateTime = doc.updatedAt;
  $('#document-date').textContent = `更新于 ${new Date(doc.updatedAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`;
}
function saveInlineName(edit) {
  edit.doc.title = edit.input.value.trim() || '未命名';
  edit.doc.updatedAt = new Date().toISOString();
  persist();
  if (edit.doc.id === openedId) { renderBreadcrumb(edit.doc); renderUpdatedAt(edit.doc); }
}
function finishInlineName(cancel = false, focus = false) {
  if (!inlineEdit) return;
  const edit = inlineEdit;
  inlineEdit = null;
  if (cancel) edit.input.value = edit.original;
  if (cancel || edit.doc.title !== (edit.input.value.trim() || '未命名')) saveInlineName(edit);
  edit.file.querySelector('.tree-name').textContent = edit.doc.title;
  edit.file.title = edit.doc.title;
  edit.row.parentElement.setAttribute('aria-label', edit.doc.title);
  edit.row.querySelector('.tree-rename').setAttribute('aria-label', `改名 ${edit.doc.title}`);
  edit.row.querySelector('.tree-add').setAttribute('aria-label', `在 ${edit.doc.title} 下新建文档`);
  const toggle = edit.row.querySelector('.toggle');
  toggle.setAttribute('aria-label', `${toggle.classList.contains('open') ? '折叠' : '展开'} ${edit.doc.title}`);
  edit.input.replaceWith(edit.file);
  edit.row.classList.remove('renaming');
  if (focus) edit.file.focus();
  if (pendingTreeRefresh) { pendingTreeRefresh = false; queueMicrotask(renderTree); }
}
function beginInlineName(id, isNew = false) {
  hideDocumentMenu(); finishInlineName();
  const doc = state.documents.find(d => d.id === id); if (!doc) return;
  $('#search').value = '';
  let ancestor = state.documents.find(d => d.id === doc.parentId);
  while (ancestor) {
    if (!state.expanded.includes(ancestor.id)) state.expanded.push(ancestor.id);
    ancestor = state.documents.find(d => d.id === ancestor.parentId);
  }
  renderTree(); setSidebar(true);
  const row = [...document.querySelectorAll('.tree-row')].find(el => el.dataset.documentId === id);
  const file = row.querySelector('.tree-file');
  const input = document.createElement('input');
  input.className = 'tree-name-input'; input.maxLength = 120; input.value = isNew ? '' : doc.title;
  input.placeholder = '未命名'; input.setAttribute('aria-label', '文档名称');
  input.autocomplete = 'off';
  inlineEdit = { doc, input, file, row, original: doc.title };
  input.oninput = () => { if (inlineEdit?.input === input) saveInlineName(inlineEdit); };
  input.onblur = () => { if (inlineEdit?.input === input) finishInlineName(); };
  input.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault(); finishInlineName(event.key === 'Escape', true);
    }
  };
  row.classList.add('renaming'); file.replaceWith(input);
  input.focus(); input.select(); input.scrollIntoView({ block: 'nearest' });
}
function newInlineDocument(parentId = null) {
  finishInlineName();
  const doc = createDocument(state, '', parentId);
  $('#search').value = ''; persist(); openDocument(doc.id, true); beginInlineName(doc.id, true);
}
$('#document-content').oninput = () => {
  const doc = currentDocument(); if (!doc) return;
  doc.content = $('#document-content').value; doc.updatedAt = new Date().toISOString();
  $('#word-count').textContent = `${wordCount(doc.content).toLocaleString()} 字`; renderUpdatedAt(doc); persist();
};
$('#close-document').onclick = closeDocument;
function requestDelete(id) {
  const doc = state.documents.find(d => d.id === id); if (!doc) return;
  pendingDeleteId = id;
  const count = descendants(state, doc.id).size - 1;
  $('#delete-description').textContent = `「${doc.title}」${count ? `及其 ${count} 篇子文档` : ''}将被永久删除。此操作无法撤销。`;
  $('#delete-dialog').showModal();
}
$('#delete-form').onsubmit = event => {
  event.preventDefault(); deleteDocument(state, pendingDeleteId); pendingDeleteId = null;
  $('#delete-dialog').close();
  if (openedId && !currentDocument()) closeDocument();
  else { persist(); renderTree(); }
  toast('文档已删除');
};
function hideDocumentMenu(restoreFocus = false) {
  $('#document-menu').classList.add('hidden');
  if (restoreFocus) [...document.querySelectorAll('.tree-row')].find(row => row.dataset.documentId === menuDocumentId)?.querySelector('.tree-file')?.focus();
}
function showDocumentMenu(id, x, y) {
  finishInlineName(); menuDocumentId = id;
  const menu = $('#document-menu'); menu.classList.remove('hidden');
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  $('#menu-rename').focus();
}
$('#menu-rename').onclick = () => beginInlineName(menuDocumentId);
$('#menu-delete').onclick = () => { hideDocumentMenu(); requestDelete(menuDocumentId); };
document.addEventListener('pointerdown', event => { if (!$('#document-menu').contains(event.target)) hideDocumentMenu(); });
window.addEventListener('resize', () => hideDocumentMenu());
document.addEventListener('scroll', () => hideDocumentMenu(), true);
$('#document-menu').onkeydown = event => {
  if (event.key === 'Escape' || event.key === 'Tab') { hideDocumentMenu(true); if (event.key === 'Escape') event.preventDefault(); }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const next = event.key === 'Home' ? $('#menu-rename') : event.key === 'End' ? $('#menu-delete') : document.activeElement === $('#menu-rename') ? $('#menu-delete') : $('#menu-rename');
    next.focus();
  }
};
['#new-document', '#empty-create'].forEach(id => $(id).onclick = () => newInlineDocument());
$('#search').oninput = renderTree;

function renderAgents() {
  chat?.refreshAgents();
  const list = $('#agent-list'); list.replaceChildren();
  $('#agent-count').textContent = state.agents.length;
  $('#agents-empty').classList.toggle('hidden', state.agents.length > 0);
  state.agents.forEach(agent => {
    const button = document.createElement('button');
    button.className = 'agent-item' + (onlineAgents.has(agent.id) ? ' online' : '');
    button.textContent = agent.name;
    button.title = `${agent.name} · ${onlineAgents.has(agent.id) ? '在线 · MCP 已连接' : '离线'}`;
    button.setAttribute('aria-label', button.title);
    button.onclick = () => showAgentDialog(agent.id); list.append(button);
  });
}
function renderConnectionState() {
  const online = onlineAgents.has(editingAgentId);
  $('#disconnect-agent').disabled = !online;
  $('#disconnect-agent').classList.toggle('hidden', !online);
  $('#activate-automatic').classList.toggle('hidden', !editingAgentId);
  $('#delete-agent').classList.toggle('hidden', !editingAgentId);
  $('#agent-mode-label').textContent = online ? '在线 · MCP 已连接' : '离线存档';
}
function showAgentDialog(id = null) {
  editingAgentId = id;
  agentDialogBase = structuredClone(state);
  const agent = state.agents.find(a => a.id === id);
  $('#agent-name').value = agent?.name || '';
  $('#agent-memory').value = agent?.memory || '';
  renderConnectionState();
  $('#agent-dialog').showModal(); $('#agent-name').focus();
}
['#new-agent', '#empty-agent'].forEach(id => $(id).onclick = () => showAgentDialog());
$('#disconnect-agent').onclick = async () => {
  try { await api('disconnect', { agentId: editingAgentId }); await sync.refresh(); toast('连接已断开，存档与记忆保留'); }
  catch (error) { toast(error.message); }
};
$('#activate-automatic').onclick=()=>{if(editingAgentId){$('#agent-dialog').close();automatic.activate(editingAgentId);}};
$('#delete-agent').onclick = () => {
  const agent = state.agents.find(item => item.id === editingAgentId);
  if (!agent) return;
  pendingAgentDeleteId = agent.id;
  $('#delete-agent-error').textContent = '';
  $('#delete-agent-description').textContent = `将删除「${agent.name}」的存档名称和记忆笔记，并断开它的所有连接、停止自动回复。已有文档和历史聊天记录会保留。此操作无法在页面内撤销。`;
  $('#agent-dialog').close();
  $('#delete-agent-dialog').showModal();
  $('#cancel-delete-agent').focus();
};
$('#delete-agent-dialog').addEventListener('cancel', event => { if (deletingAgent) event.preventDefault(); });
$('#delete-agent-dialog').addEventListener('close', () => {
  if (pendingAgentDeleteId && state.agents.some(item => item.id === pendingAgentDeleteId)) $('#agent-dialog').showModal();
  pendingAgentDeleteId = null;
});
$('#delete-agent-form').onsubmit = async event => {
  event.preventDefault();
  if (deletingAgent || !pendingAgentDeleteId) return;
  const id = pendingAgentDeleteId;
  deletingAgent = true;
  $('#confirm-delete-agent').disabled = true;
  $('#cancel-delete-agent').disabled = true;
  $('#confirm-delete-agent').textContent = '正在删除…';
  try {
    const packet = await api('agents/delete', { agentId:id });
    state.agents = state.agents.filter(agent => agent.id !== id);
    onlineAgents.delete(id); editingAgentId = null; pendingAgentDeleteId = null;
    persist(); renderAgents();
    window.dispatchEvent(new CustomEvent('quillhaven-automatic', {detail:packet.automatic}));
    $('#delete-agent-dialog').close();
    $('#new-agent').focus();
    sync.refresh();
    toast('存档已删除，文档和历史聊天已保留');
  } catch (error) { $('#delete-agent-error').textContent = `删除失败：${error.message}。请重试。`; }
  finally {
    deletingAgent = false;
    $('#confirm-delete-agent').disabled = false;
    $('#cancel-delete-agent').disabled = false;
    $('#confirm-delete-agent').textContent = '确认删除';
  }
};
$('#agent-form').onsubmit = event => {
  event.preventDefault(); const name = $('#agent-name').value.trim(); if (!name) { $('#agent-name').focus(); return; }
  const desired = structuredClone(agentDialogBase);
  let agent = desired.agents.find(a => a.id === editingAgentId);
  if (!agent) { agent = { id: makeId(), name, memory: '' }; desired.agents.push(agent); }
  agent.name = name; agent.memory = $('#agent-memory').value;
  const merged = mergeWorkspace(state, agentDialogBase, desired);
  state = merged.workspace;
  const saved = persist(); renderAgents(); $('#agent-dialog').close();
  toast(merged.conflicts[0] || (saved ? '存档已记录，正在同步到本机数据库' : '保存失败，请导出工作空间备份'));
};
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => document.getElementById(button.dataset.close).close());
function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = theme;
  $('#toggle-theme').innerHTML = icon(dark ? 'sun' : 'moon');
  $('#toggle-theme').setAttribute('aria-pressed', String(dark));
  $('#toggle-theme').setAttribute('aria-label', dark ? '切换日间模式' : '切换夜间模式');
  $('#toggle-theme').title = dark ? '切换日间模式' : '切换夜间模式';
  $('meta[name="theme-color"]').content = dark ? '#181c21' : '#fafbf9';
}
applyTheme(document.documentElement.dataset.theme || 'light');
$('#toggle-theme').onclick = () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try { localStorage.setItem('quillhaven.theme', theme); } catch { toast('主题已切换，但当前浏览器无法保存偏好'); }
};
function setSidebar(visible) { document.body.classList.toggle('sidebar-hidden', !visible); $('#toggle-sidebar').setAttribute('aria-expanded', String(visible)); scheduleConnector(); }
$('#toggle-sidebar').onclick = () => setSidebar(document.body.classList.contains('sidebar-hidden'));
if (window.matchMedia('(max-width:600px)').matches) setSidebar(false);
$('#export-workspace').onclick = async () => {
  const button = $('#export-workspace'); button.disabled = true;
  let chatMessages;
  try { chatMessages = await chat.exportMessages(); }
  catch { button.disabled = false; toast('交流记录读取失败，完整备份尚未导出，请重试。'); return; }
  const blob = new Blob([JSON.stringify({ ...state, chatTimeZone: chat.timeZone, chatMessages }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = `Quillhaven-${new Date().toLocaleDateString('sv-SE')}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); button.disabled = false; toast('文档、Agent 存档与全部交流记录已导出');
};
document.addEventListener('keydown', event => {
  const editing = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (event.key === '/' && !editing && !document.querySelector('dialog[open]')) { event.preventDefault(); setSidebar(true); $('#search').focus(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (persist()) sync.refresh(); else toast('未能保存，请导出备份'); }
});
window.addEventListener('resize', scheduleConnector);
document.addEventListener('scroll', scheduleConnector, true);
const connectorObserver = new ResizeObserver(scheduleConnector);
[$('.app-shell'), $('.tree-scroll'), $('#document-tree')].forEach(element => connectorObserver.observe(element));
chat = setupChat({ getAgents: () => state.agents, showChat: () => { if (openedId) closeDocument(); }, notify: toast });
automatic = setupAutomatic({getAgents:()=>state.agents,notify:toast});
renderTree(); renderAgents();
if (openedId) openDocument(openedId);
if (loadError) { $('#save-status').textContent = '旧存档读取失败'; toast('旧存档读取失败，已保留原始数据，未覆盖。'); }

sync = startWorkspaceSync({
  getState: () => state, notify: toast,
  status: text => { $('#save-status').textContent = text; },
  onPresence: ids => {
    const changed = JSON.stringify([...onlineAgents].sort()) !== JSON.stringify([...ids].sort());
    onlineAgents.clear(); for (const id of ids) onlineAgents.add(id);
    if (changed) renderAgents();
    if ($('#agent-dialog').open) renderConnectionState();
  },
  apply: incoming => {
    const treeChanged = JSON.stringify(state.documents.map(({content,updatedAt,revision,...rest}) => rest)) !== JSON.stringify(incoming.documents.map(({content,updatedAt,revision,...rest}) => rest));
    const agentsChanged = JSON.stringify(state.agents) !== JSON.stringify(incoming.agents);
    state = { ...incoming, selectedId: state.selectedId, expanded: state.expanded };
    if (editingAgentId && !state.agents.some(agent => agent.id === editingAgentId)) {
      editingAgentId = null; pendingAgentDeleteId = null;
      $('#agent-dialog').close(); $('#delete-agent-dialog').close();
    }
    if (inlineEdit) inlineEdit.doc = state.documents.find(d => d.id === inlineEdit.doc.id) || inlineEdit.doc;
    if (treeChanged && inlineEdit) pendingTreeRefresh = true;
    else if (treeChanged) renderTree();
    renderWorkspaceName();
    if (agentsChanged) renderAgents();
    const doc = currentDocument();
    if (openedId && !doc) { closeDocument(); return; }
    if (doc) {
      const editor = $('#document-content');
      if (editor.value !== doc.content) {
        const start = editor.selectionStart, end = editor.selectionEnd, scroll = editor.scrollTop;
        editor.value = doc.content; editor.setSelectionRange(start, end); editor.scrollTop = scroll;
        lineNumbers.update();
        $('#word-count').textContent = `${wordCount(doc.content).toLocaleString()} 字`;
      }
      renderUpdatedAt(doc);
    }
  }
});
