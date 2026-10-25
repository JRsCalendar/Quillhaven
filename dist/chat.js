import { CHAT_TIME_ZONE, recentDays, dateLabel, openChatStore, saveMessage, readMessages, readDays, exportMessages } from './chat-store.js';

export function setupChat({ getAgents, showChat, notify }) {
  const $ = selector => document.querySelector(selector);
  const DRAFT_KEY = 'quillhaven.chat.draft.v1';
  const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: CHAT_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false });
  let ready = false, sending = false, recentVersion = 0, archiveVersion = 0, dayVersion = 0;
  let currentDays = recentDays(), recentPage, archivePage, archiveDay, daysLimit = 60;
  let recentRows = [], archiveRows = [];
  let pendingSend = null;
  const input = $('#chat-input');
  const recipient = $('#chat-recipient');
  let draftRecipient = 'all';
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
    input.value = typeof draft.text === 'string' ? draft.text : '';
    draftRecipient = draft.recipient || 'all';
  } catch { /* An unavailable draft does not affect saved chat history. */ }
  function persistDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: input.value, recipient: recipient.value })); }
    catch { $('#composer-notice').textContent = '草稿暂时无法保存；已归档的消息不受影响。'; }
  }
  function refreshAgents() {
    const selected = recipient.value || draftRecipient;
    recipient.replaceChildren(new Option('所有写作伙伴', 'all'));
    for (const agent of getAgents()) recipient.append(new Option(agent.name, agent.id));
    recipient.value = [...recipient.options].some(option => option.value === selected) ? selected : 'all';
  }
  function updateComposer() {
    $('#send-message').disabled = !ready || sending || !input.value.trim();
    $('#send-message').textContent = sending ? '保存中…' : '发送';
    $('#draft-count').textContent = input.value.length ? `${input.value.length.toLocaleString()} 字符` : '';
  }
  function buildMessages(rows, target) {
    const fragment = document.createDocumentFragment();
    let previousDay;
    for (const message of rows) {
      if (message.day !== previousDay) {
        const date = document.createElement('div'); date.className = 'chat-date-divider';
        const label = document.createElement('span'); label.textContent = dateLabel(message.day);
        date.append(label); fragment.append(date); previousDay = message.day;
      }
      const article = document.createElement('article');
      article.className = `message ${message.role === 'user' ? 'from-user' : 'from-agent'}`;
      const meta = document.createElement('header'); meta.className = 'message-meta';
      const author = document.createElement('strong'); author.textContent = message.senderName;
      const time = document.createElement('time'); time.dateTime = message.createdAt; time.textContent = clock.format(new Date(message.createdAt));
      meta.append(author, time);
      const body = document.createElement('div'); body.className = 'message-body'; body.textContent = message.content;
      const foot = document.createElement('div'); foot.className = 'message-delivery';
      const delivery = message.role !== 'user' ? '已回复 · MCP' : message.delivery === 'local-only' ? '旧版本地记录' : message.repliedBy?.length ? `已有 ${message.repliedBy.length} 位伙伴回复` : message.readBy?.length ? `已有 ${message.readBy.length} 位伙伴读到` : '等待伙伴读取';
      foot.textContent = `${message.recipientNames.length ? `发给 ${message.recipientNames.join('、')} · ` : ''}${delivery}`;
      article.append(meta, body, foot); fragment.append(article);
    }
    target.replaceChildren(fragment);
  }
  async function loadRecent(older = false, scrollToBottom = false, live = false) {
    const version = ++recentVersion;
    const scroller = $('#chat-scroll');
    const oldHeight = scroller.scrollHeight, oldTop = scroller.scrollTop;
    const page = await readMessages({ from: currentDays.yesterday, to: currentDays.today, before: older ? recentPage?.before : null });
    if (version !== recentVersion) return;
    if (!live) recentPage = page;
    if (live) {
      const merged = new Map(recentRows.filter(row => row.day >= currentDays.yesterday && row.day <= currentDays.today).map(row => [row.id,row]));
      page.messages.forEach(row => merged.set(row.id,row));
      recentRows = [...merged.values()].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    } else recentRows = older ? [...page.messages, ...recentRows] : page.messages;
    buildMessages(recentRows, $('#chat-messages'));
    $('#chat-empty').classList.toggle('hidden', recentRows.length > 0);
    if (!live) $('#recent-older').classList.toggle('hidden', !page.hasMore);
    $('#chat-window-label').textContent = '今天 · 昨天';
    if (older) scroller.scrollTop = oldTop + scroller.scrollHeight - oldHeight;
    else if (scrollToBottom) scroller.scrollTop = scroller.scrollHeight;
  }
  async function loadDays() {
    const version = ++dayVersion;
    const result = await readDays(daysLimit);
    if (version !== dayVersion) return;
    const fragment = document.createDocumentFragment();
    let month;
    for (const day of result.days) {
      if (day.day.slice(0, 7) !== month) {
        month = day.day.slice(0, 7);
        const heading = document.createElement('h3'); heading.className = 'history-month'; heading.textContent = `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`; fragment.append(heading);
      }
      const button = document.createElement('button'); button.className = 'history-day';
      button.setAttribute('aria-label', `查看 ${day.day} 的交流记录，${day.count} 条消息`);
      const title = document.createElement('span'); title.className = 'history-day-title'; title.textContent = dateLabel(day.day);
      const count = document.createElement('span'); count.className = 'history-day-count'; count.textContent = `${day.count} 条`;
      const preview = document.createElement('span'); preview.className = 'history-day-preview'; preview.textContent = day.preview;
      button.append(title, count, preview);
      button.onclick = () => openArchive(day.day);
      fragment.append(button);
    }
    $('#history-days').replaceChildren(fragment);
    $('#history-empty').classList.toggle('hidden', result.days.length > 0);
    $('#history-more').classList.toggle('hidden', !result.hasMore);
  }
  async function loadArchive(older = false) {
    const version = ++archiveVersion;
    const scroller = $('#archive-scroll');
    const oldHeight = scroller.scrollHeight, oldTop = scroller.scrollTop;
    const page = await readMessages({ from: archiveDay, to: archiveDay, before: older ? archivePage?.before : null });
    if (version !== archiveVersion) return;
    archivePage = page;
    archiveRows = older ? [...page.messages, ...archiveRows] : page.messages;
    buildMessages(archiveRows, $('#archive-messages'));
    $('#archive-older').classList.toggle('hidden', !page.hasMore);
    $('#archive-state').textContent = archiveRows.length ? '只读记录 · 不影响当前交流' : '这一天还没有交流记录';
    scroller.scrollTop = older ? oldTop + scroller.scrollHeight - oldHeight : scroller.scrollHeight;
  }
  async function openArchive(day) {
    archiveDay = day; archivePage = null; archiveRows = [];
    $('#archive-title').textContent = `${dateLabel(day)} 的交流记录`;
    $('#archive-messages').replaceChildren(); $('#archive-older').classList.add('hidden');
    $('#archive-state').textContent = '正在读取…';
    $('#history-dialog').showModal();
    try { await loadArchive(); } catch { $('#archive-state').textContent = '记录读取失败，请关闭后重试'; }
  }
  function loadFailed() { notify('交流记录读取失败，请重试；已保存的数据未被删除。'); }
  async function refreshDayBoundary() {
    const next = recentDays();
    if (next.today === currentDays.today) return;
    currentDays = next;
    try { await Promise.all([loadRecent(false, true), loadDays()]); } catch { loadFailed(); }
  }
  $('#composer-form').onsubmit = async event => {
    event.preventDefault();
    if (!ready || sending || !input.value.trim()) return;
    const content = input.value;
    const selected = recipient.value;
    const agents = selected === 'all' ? getAgents() : getAgents().filter(agent => agent.id === selected);
    sending = true; updateComposer();
    try {
      if (!pendingSend || pendingSend.content !== content || pendingSend.selected !== selected) pendingSend = { id: crypto.randomUUID(), content, selected };
      await saveMessage({ id: pendingSend.id, content, recipientIds: selected === 'all' ? [] : agents.map(agent => agent.id), broadcast: selected === 'all' });
      pendingSend = null;
    } catch {
      sending = false; updateComposer(); notify('消息未能保存，输入内容已保留，请重试。'); return;
    }
    if (input.value === content) input.value = '';
    persistDraft(); sending = false; updateComposer();
    currentDays = recentDays(); showChat();
    try { await Promise.all([loadRecent(false, true), loadDays()]); }
    catch { notify('消息已经保存，但显示刷新失败，请刷新页面查看。'); }
    notify('消息已发送');
    input.focus();
  };
  input.oninput = () => { persistDraft(); updateComposer(); };
  input.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer-form').requestSubmit(); }
  };
  recipient.onchange = persistDraft;
  $('#recent-older').onclick = () => loadRecent(true).catch(loadFailed);
  $('#archive-older').onclick = () => loadArchive(true).catch(loadFailed);
  $('#history-more').onclick = () => { daysLimit += 60; loadDays().catch(loadFailed); };
  $('#history-dialog').addEventListener('close', () => { archiveVersion++; });
  $('#toggle-history').onclick = () => {
    const open = document.body.classList.toggle('history-open');
    $('#toggle-history').setAttribute('aria-expanded', String(open));
  };
  $('#close-history-panel').onclick = () => { document.body.classList.remove('history-open'); $('#toggle-history').setAttribute('aria-expanded', 'false'); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDayBoundary(); });
  window.addEventListener('focus', refreshDayBoundary);
  function scheduleMidnight() {
    const midnight = new Date(`${recentDays().today}T00:00:00+08:00`).getTime() + 86400000;
    setTimeout(async () => { await refreshDayBoundary(); scheduleMidnight(); }, Math.max(100, midnight - Date.now() + 30));
  }
  scheduleMidnight();
  recipient.value = draftRecipient;
  refreshAgents(); updateComposer();
  openChatStore().then(async () => {
    ready = true; updateComposer();
    await Promise.all([loadRecent(false, true), loadDays()]);
  }).catch(() => {
    ready = false; updateComposer(); $('#composer-notice').textContent = '本机服务暂时不可用，草稿已保留，请启动服务后刷新。';
  });
  window.addEventListener('quillhaven-chat-update', async () => {
    if (!ready) return;
    const scroll = $('#chat-scroll');
    const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    try {
      await Promise.all([loadRecent(false, follow, true), loadDays()]);
      if ($('#history-dialog').open && archiveDay) await loadArchive();
    } catch { /* Next successful sync or reload will catch up. */ }
  });
  return { refreshAgents, exportMessages, timeZone: CHAT_TIME_ZONE };
}
