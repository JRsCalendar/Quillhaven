import { sharedWorkspace, mergeWorkspace } from './workspace-merge.js';
import { exportMessages as exportLegacyMessages } from './legacy-chat-store.js';
import { STORAGE_KEY } from './store.js';

export async function api(route, value, options = {}) {
  const response = await fetch(`/api/${route}`, { cache: 'no-store', signal: AbortSignal.timeout(15000), ...options,
    ...(value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Quillhaven': '1' }, body: JSON.stringify(value) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '本机服务暂时不可用');
  return result;
}
const BASE_KEY = 'quillhaven.sync-base.v2';
let baseline;
export async function initializeWorkspace(local) {
  let migrationId = localStorage.getItem('quillhaven.migration-id.v2');
  if (!migrationId) {
    migrationId = crypto.randomUUID();
    localStorage.setItem('quillhaven.migration-id.v2', migrationId);
  }
  if (!localStorage.getItem('quillhaven.browser-backup.v1')) localStorage.setItem('quillhaven.browser-backup.v1', JSON.stringify(local));
  const oldBase = JSON.parse(localStorage.getItem(BASE_KEY) || 'null');
  const packet = await api('migrate', { id: migrationId, workspace: sharedWorkspace(local), messages: await exportLegacyMessages() });
  baseline = packet.workspace;
  const merged = oldBase ? mergeWorkspace(baseline, oldBase, sharedWorkspace(local)) : { workspace: baseline, conflicts: [] };
  localStorage.setItem(BASE_KEY, JSON.stringify(baseline));
  return { ...packet, workspace: { ...merged.workspace, selectedId: local.selectedId, expanded: local.expanded }, conflicts: merged.conflicts };
}
export function startWorkspaceSync({ getState, apply, status, onPresence, notify }) {
  let timer, busy = false, connected = true, lastMessages = '', initial = true, composing = false;
  const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const pending = () => !equal(sharedWorkspace(getState()), baseline);
  function cache() { localStorage.setItem(STORAGE_KEY, JSON.stringify(getState())); localStorage.setItem(BASE_KEY, JSON.stringify(baseline)); }
  function presence(packet) {
    onPresence(packet.onlineAgentIds);
    if(packet.automatic)window.dispatchEvent(new CustomEvent('quillhaven-automatic',{detail:packet.automatic}));
    const version = `${packet.messageVersion}:${packet.receiptVersion}`;
    if (version !== lastMessages) { lastMessages = version; window.dispatchEvent(new Event('quillhaven-chat-update')); }
  }
  async function run() {
    if (busy || composing) return;
    busy = true;
    try {
      const sent = structuredClone(sharedWorkspace(getState()));
      const dirty = pending();
      const packet = dirty ? await api('workspace', { base: baseline, workspace: sent }) : await api('state');
      if (composing) return;
      // Preserve keystrokes made while the request was in flight.
      const merged = mergeWorkspace(packet.workspace, sent, sharedWorkspace(getState()));
      baseline = packet.workspace;
      apply(merged.workspace); cache(); presence(packet);
      for (const message of [...(packet.conflicts || []), ...merged.conflicts]) notify(message);
      connected = true; status(pending() ? '待同步到本机服务…' : '已保存到本机数据库');
      initial = false;
    } catch (error) {
      connected = false; onPresence([]); status('本机服务未连接 · 编辑已留在浏览器');
      window.dispatchEvent(new Event('quillhaven-offline'));
      if (initial) { notify(error.message); initial = false; }
    } finally { busy = false; }
  }
  function queue() { clearTimeout(timer); status('正在保存到本机…'); timer = setTimeout(run, 350); }
  document.addEventListener('compositionstart', () => { composing = true; });
  document.addEventListener('compositionend', () => { composing = false; queue(); });
  setInterval(run, 1800);
  window.addEventListener('focus', run);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });
  window.addEventListener('beforeunload', () => {
    if (!pending()) return;
    // The browser cache also retains any unacknowledged edits for the next open.
    fetch('/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Quillhaven': '1' }, body: JSON.stringify({ base: baseline, workspace: sharedWorkspace(getState()) }), keepalive: true }).catch(() => {});
  });
  run();
  return { queue, refresh: run, get connected() { return connected; } };
}
