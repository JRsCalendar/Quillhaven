export { CHAT_TIME_ZONE, dayKey, recentDays, dateLabel } from './legacy-chat-store.js';
import { api } from './local-api.js';
export const openChatStore = () => api('state');
export const saveMessage = message => api('messages', message);
export function readMessages({ from, to, before = null, limit = 80 }) {
  const query = new URLSearchParams({ from, to, limit });
  if (before) query.set('before', JSON.stringify(before));
  return api(`messages?${query}`);
}
export const readDays = (limit = 60) => api(`days?limit=${limit}`);
export const exportMessages = async () => (await api('export')).chatMessages;
