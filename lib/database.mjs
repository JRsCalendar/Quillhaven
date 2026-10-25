import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { initialState, parseState } from '../dist/store.js';
import { dayKey } from '../dist/legacy-chat-store.js';
import { mergeWorkspace, sharedWorkspace } from '../dist/workspace-merge.js';

export const defaultDataDir = fileURLToPath(new URL('../data/', import.meta.url));
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const now = () => new Date().toISOString();
export function openDatabase(directory = process.env.QUILLHAVEN_DATA_DIR || defaultDataDir) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'quillhaven.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY, document_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, actor TEXT NOT NULL, saved_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS history_document ON history(document_id,seq);
    CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, day TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_day ON messages(day,created_at,id);
    CREATE TABLE IF NOT EXISTS receipts (message_id TEXT NOT NULL, agent_id TEXT NOT NULL, read_at TEXT NOT NULL, replied_at TEXT, PRIMARY KEY(message_id,agent_id));
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS deleted_agents (id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auto_jobs (message_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, PRIMARY KEY(message_id,agent_id));
  `);
  db.prepare('INSERT OR IGNORE INTO workspace VALUES (1,?,0)').run(JSON.stringify(initialState()));
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function snapshot() {
    const row = db.prepare('SELECT body,revision FROM workspace WHERE id=1').get();
    return { workspace: JSON.parse(row.body), revision: row.revision,
      onlineAgentIds: db.prepare('SELECT DISTINCT agent_id FROM sessions WHERE expires>?').all(Date.now()).map(row => row.agent_id),
      messageVersion: db.prepare('SELECT COALESCE(MAX(seq),0) AS value FROM messages').get().value,
      receiptVersion: db.prepare('SELECT COUNT(*) AS value FROM receipts').get().value };
  }
  function validateWorkspace(value) {
    const clean = parseState(JSON.stringify(value));
    if (clean.documents.length > 20000 || clean.agents.length > 200) throw new AppError('工作空间数量超过上限');
    for (const doc of clean.documents) {
      if (!doc.id || doc.id.length > 200 || doc.title.length > 200 || doc.content.length > 1000000 || !Number.isFinite(Date.parse(doc.createdAt)) || !Number.isFinite(Date.parse(doc.updatedAt))) throw new AppError('文档字段无效或过长');
    }
    for (const agent of clean.agents) if (!agent.id || agent.id.length > 200 || !agent.name.trim() || agent.name.length > 100 || agent.memory.length > 200000) throw new AppError('伙伴存档字段无效或过长');
    const deleted = new Set(db.prepare('SELECT id FROM deleted_agents').all().map(row => row.id));
    clean.agents = clean.agents.filter(agent => !deleted.has(agent.id));
    return sharedWorkspace(clean);
  }
  function commitWorkspace(next, actor, preserveImportedDates = false) {
    next = validateWorkspace(next);
    const previous = snapshot();
    for (const agent of previous.workspace.agents) {
      if (next.agents.some(item => item.id === agent.id)) continue;
      db.prepare('INSERT OR IGNORE INTO deleted_agents VALUES (?,?)').run(agent.id, now());
      db.prepare('DELETE FROM sessions WHERE agent_id=?').run(agent.id);
      const setting = db.prepare("SELECT body FROM app_settings WHERE key='automatic'").get();
      if (setting && JSON.parse(setting.body).agentId === agent.id) {
        db.prepare("UPDATE app_settings SET body=? WHERE key='automatic'").run(JSON.stringify({enabled:false,agentId:null}));
      }
    }
    for (const doc of previous.workspace.documents) {
      const after = next.documents.find(item => item.id === doc.id);
      if (!after || ['title','content','parentId'].some(key => after[key] !== doc[key])) {
        db.prepare('INSERT INTO history(document_id,revision,body,actor,saved_at) VALUES (?,?,?,?,?)').run(doc.id, doc.revision || 1, JSON.stringify(doc), actor, now());
      }
    }
    for (const doc of next.documents) {
      const before = previous.workspace.documents.find(item => item.id === doc.id);
      const changed = !before || ['title','content','parentId'].some(key => before[key] !== doc[key]);
      doc.revision = before ? (before.revision || 1) + Number(changed) : 1;
      if (changed && !(preserveImportedDates && !before)) doc.updatedAt = now();
    }
    if (!same(next, previous.workspace)) db.prepare('UPDATE workspace SET body=?,revision=revision+1 WHERE id=1').run(JSON.stringify(next));
    return snapshot();
  }
  function syncWorkspace(base, next) {
    base = validateWorkspace(base); next = validateWorkspace(next);
    return transaction(() => {
      const merged = mergeWorkspace(snapshot().workspace, base, next, randomUUID);
      return { ...commitWorkspace(merged.workspace, '你'), conflicts: merged.conflicts };
    });
  }
  function validateMessage(message) {
    if (typeof message.id !== 'string' || !message.id || message.id.length > 200 || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 50000) throw new AppError('消息内容或编号无效');
    if (!['user','assistant'].includes(message.role) || !Number.isFinite(Date.parse(message.createdAt))) throw new AppError('消息格式无效');
    if (!Array.isArray(message.recipientIds) || !Array.isArray(message.recipientNames) || [...message.recipientIds, ...message.recipientNames].some(x => typeof x !== 'string')) throw new AppError('消息接收者无效');
    if (typeof message.senderName !== 'string') throw new AppError('消息发送者无效');
    return { ...message, createdAt: new Date(message.createdAt).toISOString(), day: dayKey(new Date(message.createdAt)) };
  }
  function insertMessage(value) {
    const message = validateMessage(value);
    const previous = db.prepare('SELECT body FROM messages WHERE id=?').get(message.id);
    if (previous) {
      const old = JSON.parse(previous.body);
      if (old.content !== message.content || old.role !== message.role || old.agentId !== message.agentId || !same(old.recipientIds, message.recipientIds) || !same(old.replyTo || [], message.replyTo || [])) throw new AppError('该消息编号已经用于不同内容', 409);
      return old;
    }
    db.prepare('INSERT INTO messages(id,day,created_at,body) VALUES (?,?,?,?)').run(message.id, message.day, message.createdAt, JSON.stringify(message));
    return message;
  }
  function migrate({ id, workspace, messages }) {
    if (typeof id !== 'string' || id.length > 200 || !Array.isArray(messages)) throw new AppError('迁移数据无效');
    const valid = validateWorkspace(workspace);
    return transaction(() => {
      if (db.prepare('SELECT id FROM migrations WHERE id=?').get(id)) return snapshot();
      // Keep the exact original browser payload as a recoverable backup in the database.
      db.prepare('INSERT INTO migrations VALUES (?,?,?)').run(id, JSON.stringify({ workspace, messages }), now());
      const current = snapshot().workspace;
      const merged = mergeWorkspace(current, initialState(), valid, randomUUID);
      if (current.documents.length) merged.workspace.workspaceName = current.workspaceName;
      commitWorkspace(merged.workspace, '浏览器迁移', true);
      // Old local-only messages are historical, never silently put into an agent inbox.
      for (const message of messages) insertMessage({ ...message, role: message.role === 'user' ? 'user' : 'assistant', delivery: 'local-only' });
      return snapshot();
    });
  }
  function messageRow(row) {
    const result = { ...JSON.parse(row.body), seq: row.seq };
    const receipts = db.prepare('SELECT agent_id,read_at,replied_at FROM receipts WHERE message_id=?').all(result.id);
    result.readBy = receipts.map(r => r.agent_id);
    result.repliedBy = receipts.filter(r => r.replied_at).map(r => r.agent_id);
    return result;
  }
  function readMessages({ from = '0000', to = '9999', before = null, limit = 80 } = {}) {
    limit = Math.min(500, Math.max(1, Number(limit) || 80));
    const rows = before
      ? db.prepare('SELECT * FROM messages WHERE day>=? AND day<=? AND (day,created_at,id)<(?,?,?) ORDER BY day DESC,created_at DESC,id DESC LIMIT ?').all(from, to, ...before, limit + 1)
      : db.prepare('SELECT * FROM messages WHERE day>=? AND day<=? ORDER BY day DESC,created_at DESC,id DESC LIMIT ?').all(from, to, limit + 1);
    const hasMore = rows.length > limit; const page = rows.slice(0, limit); const oldest = page.at(-1);
    return { messages: page.reverse().map(messageRow), hasMore, before: oldest ? [oldest.day, oldest.created_at, oldest.id] : null };
  }
  function readDays(limit = 60) {
    limit = Math.min(20000, Math.max(1, Number(limit) || 60));
    const days = db.prepare('SELECT day,COUNT(*) AS count,MAX(created_at) AS updatedAt FROM messages GROUP BY day ORDER BY day DESC LIMIT ?').all(limit + 1);
    return { hasMore: days.length > limit, days: days.slice(0, limit).map(day => ({ ...day, preview: JSON.parse(db.prepare('SELECT body FROM messages WHERE day=? ORDER BY created_at DESC,id DESC LIMIT 1').get(day.day).body).content.slice(0,90) })) };
  }
  function connectAgent({ agentId, name = 'Codex' }, sessionId) {
    return transaction(() => {
      const state = snapshot().workspace;
      let agent;
      if (agentId) { agent = state.agents.find(a => a.id === agentId); if (!agent) throw new AppError('找不到此存档'); }
      else {
        const matches = state.agents.filter(a => a.name === name);
        if (matches.length > 1) throw new AppError('存在同名存档，请用 agentId 选择');
        agent = matches[0];
        if (!agent) { agent = { id: randomUUID(), name, memory: '' }; state.agents.push(agent); commitWorkspace(state, name); }
      }
      db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?)').run(sessionId, agent.id, Date.now() + 45000);
      return { agent, pending: inbox(sessionId, 20, false), note: '记忆来自本地存档。先阅读再讨论，只有用户授权的设定才写入文档；结束前主动保存记忆。网页自动模式由 Codex 运行器触发，手动 MCP 客户端不会自行唤醒模型。' };
    });
  }
  function sessionAgent(sessionId) {
    const session = db.prepare('SELECT agent_id FROM sessions WHERE id=? AND expires>?').get(sessionId, Date.now());
    const agent = session && snapshot().workspace.agents.find(a => a.id === session.agent_id);
    if (!agent) throw new AppError('请先调用 connect_agent 选择伙伴存档（连接可能已断开）', 409);
    return agent;
  }
  function inbox(sessionId, limit = 40, markRead = true) {
    const agent = sessionAgent(sessionId);
    const rows = db.prepare(`SELECT m.* FROM messages m WHERE json_extract(m.body,'$.role')='user'
      AND json_extract(m.body,'$.delivery')='queued'
      AND (json_extract(m.body,'$.broadcast')=1 OR EXISTS(SELECT 1 FROM json_each(m.body,'$.recipientIds') WHERE value=?))
      AND NOT EXISTS(SELECT 1 FROM receipts r WHERE r.message_id=m.id AND r.agent_id=? AND r.replied_at IS NOT NULL)
      ORDER BY m.seq LIMIT ?`).all(agent.id, agent.id, Math.min(100, Math.max(1, limit)));
    if (markRead) for (const row of rows) db.prepare('INSERT OR IGNORE INTO receipts VALUES (?,?,?,NULL)').run(row.id, agent.id, now());
    return rows.map(messageRow);
  }
  function postReply(sessionId, { requestId, content, replyTo = [] }) {
    return transaction(() => {
      const agent = sessionAgent(sessionId);
      for (const id of replyTo) {
        const row = db.prepare('SELECT body FROM messages WHERE id=?').get(id);
        const message = row && JSON.parse(row.body);
        if (!message || message.role !== 'user' || (!message.broadcast && !message.recipientIds.includes(agent.id))) throw new AppError('回复引用必须是发给此伙伴的用户消息');
      }
      const message = insertMessage({ id: requestId, content, replyTo, role: 'assistant', agentId: agent.id, senderName: agent.name, createdAt: now(), recipientIds: [], recipientNames: [], delivery: 'delivered' });
      for (const id of replyTo) db.prepare('INSERT INTO receipts VALUES (?,?,?,?) ON CONFLICT(message_id,agent_id) DO UPDATE SET replied_at=excluded.replied_at').run(id, agent.id, now(), now());
      return message;
    });
  }
  function readDocument(id) {
    const doc = snapshot().workspace.documents.find(d => d.id === id);
    if (!doc) throw new AppError('文档不存在', 404);
    return doc;
  }
  function editDocument(sessionId, { id, expectedRevision, edits }) {
    return transaction(() => {
      const agent = sessionAgent(sessionId), state = snapshot().workspace;
      const doc = state.documents.find(d => d.id === id);
      if (!doc) throw new AppError('文档不存在', 404);
      if (doc.revision !== expectedRevision) throw new AppError(`文档已更新（当前版本 ${doc.revision}），请重新读取后编辑`, 409);
      for (const { oldText, newText } of edits) {
        if (!oldText) { if (doc.content) throw new AppError('空匹配只能用于空文档'); doc.content = newText; }
        else {
          const index = doc.content.indexOf(oldText);
          if (index < 0 || doc.content.indexOf(oldText, index + 1) >= 0) throw new AppError('待替换文本必须精确且只出现一次，请扩大上下文');
          doc.content = doc.content.slice(0, index) + newText + doc.content.slice(index + oldText.length);
        }
      }
      commitWorkspace(state, agent.name); return readDocument(id);
    });
  }
  function createAgentDocument(sessionId, { requestId, title, content = '', parentId = null }) {
    return transaction(() => {
      const agent = sessionAgent(sessionId), state = snapshot().workspace;
      const previous = state.documents.find(d => d.id === requestId);
      if (previous) {
        if (previous.title !== title || previous.content !== content || previous.parentId !== parentId) throw new AppError('文档编号已被使用', 409);
        return previous;
      }
      state.documents.push({ id: requestId, title, content, parentId, createdAt: now(), updatedAt: now() });
      commitWorkspace(state, agent.name); return readDocument(requestId);
    });
  }
  function saveMemory(sessionId, { expectedMemory, memory }) {
    return transaction(() => {
      const agent = sessionAgent(sessionId), state = snapshot().workspace;
      const target = state.agents.find(a => a.id === agent.id);
      if (target.memory !== expectedMemory) throw new AppError('记忆已经更新，请重新读取伙伴存档', 409);
      target.memory = memory; commitWorkspace(state, agent.name); return target;
    });
  }
  return {
    db, snapshot, syncWorkspace, migrate, readMessages, readDays, connectAgent, inbox, postReply, readDocument, editDocument, createAgentDocument, saveMemory,
    sendUserMessage: ({ id = randomUUID(), content, recipientIds = [], broadcast = false }) => transaction(() => {
      const agents = snapshot().workspace.agents;
      if (recipientIds.some(id => !agents.some(a => a.id === id))) throw new AppError('消息接收者已不存在');
      return insertMessage({ id, content, recipientIds, broadcast, recipientNames: broadcast ? ['所有写作伙伴'] : agents.filter(a => recipientIds.includes(a.id)).map(a => a.name), createdAt: now(), role: 'user', senderName: '你', delivery: 'queued' });
    }),
    exportMessages: () => db.prepare('SELECT * FROM messages ORDER BY day,created_at,id').all().map(messageRow),
    documentHistory: id => db.prepare('SELECT revision,body,actor,saved_at FROM history WHERE document_id=? ORDER BY seq DESC LIMIT 50').all(id).map(row => ({ ...row, document: JSON.parse(row.body), body: undefined })),
    heartbeat: sessionId => db.prepare('UPDATE sessions SET expires=? WHERE id=? AND expires>?').run(Date.now() + 45000, sessionId, Date.now()),
    disconnect: sessionId => db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId),
    disconnectAgent: agentId => db.prepare('DELETE FROM sessions WHERE agent_id=?').run(agentId),
    deleteAgent: agentId => transaction(() => {
      if (typeof agentId !== 'string' || !agentId || agentId.length > 200) throw new AppError('存档编号无效');
      const state = snapshot().workspace;
      state.agents = state.agents.filter(agent => agent.id !== agentId);
      return commitWorkspace(state, '你');
    }),
    close: () => db.close(),
    getSetting: (key, fallback) => {const row=db.prepare('SELECT body FROM app_settings WHERE key=?').get(key);return row?JSON.parse(row.body):fallback;},
    setSetting: (key, value) => db.prepare('INSERT INTO app_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key,JSON.stringify(value)),
    nextAutomaticMessage: agentId => {
      const row=db.prepare(`SELECT m.*,j.status AS job_status,j.error AS job_error FROM messages m
        LEFT JOIN auto_jobs j ON j.message_id=m.id AND j.agent_id=?
        WHERE json_extract(m.body,'$.role')='user' AND json_extract(m.body,'$.delivery')='queued'
        AND (json_extract(m.body,'$.broadcast')=1 OR EXISTS(SELECT 1 FROM json_each(m.body,'$.recipientIds') WHERE value=?))
        AND NOT EXISTS(SELECT 1 FROM receipts r WHERE r.message_id=m.id AND r.agent_id=? AND r.replied_at IS NOT NULL)
        ORDER BY m.seq LIMIT 1`).get(agentId,agentId,agentId);
      return row?{...messageRow(row),jobStatus:row.job_status,jobError:row.job_error}:null;
    },
    setAutomaticJob: (messageId,agentId,status,error='') => db.prepare('INSERT INTO auto_jobs VALUES (?,?,?,?,?) ON CONFLICT(message_id,agent_id) DO UPDATE SET status=excluded.status,error=excluded.error,updated_at=excluded.updated_at').run(messageId,agentId,status,error,now()),
    recoverAutomaticJobs: () => db.prepare("UPDATE auto_jobs SET status='failed',error='上次回复中断，请检查文档后点击重试。' WHERE status='processing'").run(),
    retryAutomaticJobs: agentId => db.prepare("UPDATE auto_jobs SET status='queued',error='' WHERE agent_id=? AND status='failed'").run(agentId)
  };
}
