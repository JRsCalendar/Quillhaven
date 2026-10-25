export const CHAT_TIME_ZONE = 'Asia/Hong_Kong';
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: CHAT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
export function dayKey(date = new Date()) {
  const parts = Object.fromEntries(dayFormatter.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function recentDays(date = new Date()) {
  const today = dayKey(date);
  const previous = new Date(`${today}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return { today, yesterday: previous.toISOString().slice(0, 10) };
}
export function dateLabel(day, now = new Date()) {
  const { today, yesterday } = recentDays(now);
  return `${day === today ? '今天 · ' : day === yesterday ? '昨天 · ' : ''}${day.replaceAll('-', '.')}`;
}
let connection;
export function openChatStore() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open('quillhaven.chat.v1', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const messages = db.createObjectStore('messages', { keyPath: 'id' });
      messages.createIndex('byDayCreated', ['day', 'createdAt', 'id']);
      db.createObjectStore('days', { keyPath: 'day' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      resolve(db);
    };
    request.onerror = () => { connection = undefined; reject(request.error); };
    request.onblocked = () => { connection = undefined; reject(new Error('请关闭其他旧版工作台后重试')); };
  });
  return connection;
}
export async function saveMessage({ content, recipientIds = [], recipientNames = [], createdAt = new Date().toISOString(), role = 'user', senderName = '你' }) {
  if (!content.trim()) throw new Error('消息不能为空');
  createdAt = new Date(createdAt).toISOString();
  const db = await openChatStore();
  const message = { id: crypto.randomUUID(), day: dayKey(new Date(createdAt)), createdAt, role, senderName, content, recipientIds, recipientNames, delivery: 'local-only' };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['messages', 'days'], 'readwrite');
    tx.objectStore('messages').add(message);
    const days = tx.objectStore('days');
    const request = days.get(message.day);
    request.onsuccess = () => {
      const previous = request.result;
      const latest = !previous || previous.updatedAt <= createdAt;
      days.put({ day: message.day, count: (previous?.count || 0) + 1, preview: latest ? content.slice(0, 90) : previous.preview, updatedAt: latest ? createdAt : previous.updatedAt });
    };
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('消息保存失败'));
    tx.onerror = () => reject(tx.error);
  });
  return message;
}
export async function readMessages({ from, to, before = null, limit = 80 }) {
  const db = await openChatStore();
  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound([from, '', ''], before || [to, '\uffff', '\uffff'], false, !!before);
    const request = db.transaction('messages').objectStore('messages').index('byDayCreated').openCursor(range, 'prev');
    const rows = [];
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length === limit) {
        const oldest = rows.at(-1);
        resolve({ messages: rows.reverse(), hasMore: !!cursor, before: oldest ? [oldest.day, oldest.createdAt, oldest.id] : null });
        return;
      }
      rows.push(cursor.value); cursor.continue();
    };
  });
}
export async function readDays(limit = 60) {
  const db = await openChatStore();
  return new Promise((resolve, reject) => {
    const request = db.transaction('days').objectStore('days').openCursor(null, 'prev');
    const days = [];
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || days.length === limit) { resolve({ days, hasMore: !!cursor }); return; }
      days.push(cursor.value); cursor.continue();
    };
  });
}
export async function exportMessages() {
  const db = await openChatStore();
  return new Promise((resolve, reject) => {
    const request = db.transaction('messages').objectStore('messages').index('byDayCreated').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
