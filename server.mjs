import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { openDatabase, AppError } from './lib/database.mjs';
import { AutoReply } from './lib/auto-reply.mjs';

export function createAppServer({ dataDir, port = Number(process.env.PORT || 5173), automatic = false, runtimeOptions = {} } = {}) {
  const store = openDatabase(dataDir);
  const auto = automatic ? new AutoReply(store,{dataDir,...runtimeOptions}) : null;
  const runtimeState=()=>auto?.snapshot()||{enabled:false,phase:'unavailable',agentId:null,agentName:'Codex',error:''};
  const root = path.resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
  const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json') || req.headers['x-quillhaven'] !== '1') throw new AppError('仅接受工作台请求', 403);
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new AppError('数据过大，请分批迁移', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('JSON 格式无效'); }
  }
  const server = http.createServer(async (req, res) => {
    const allowedHosts = new Set([`127.0.0.1:${server.address()?.port}`, `localhost:${server.address()?.port}`]);
    if (!allowedHosts.has(req.headers.host) || (req.headers.origin && ![...allowedHosts].some(host => req.headers.origin === `http://${host}`))) return json(res, { error: '不允许此来源访问本机工作空间' }, 403);
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'GET') {
          if (url.pathname === '/api/state') return json(res, {...store.snapshot(),automatic:runtimeState()});
          if (url.pathname === '/api/messages') return json(res, store.readMessages({ from: url.searchParams.get('from') || '0000', to: url.searchParams.get('to') || '9999', before: url.searchParams.has('before') ? JSON.parse(url.searchParams.get('before')) : null, limit: url.searchParams.get('limit') }));
          if (url.pathname === '/api/days') return json(res, store.readDays(url.searchParams.get('limit')));
          if (url.pathname === '/api/export') return json(res, { ...store.snapshot().workspace, chatTimeZone: 'Asia/Hong_Kong', chatMessages: store.exportMessages() });
        } else if (req.method === 'POST') {
          const value = await body(req);
          if (url.pathname === '/api/migrate') return json(res, {...store.migrate(value),automatic:runtimeState()});
          if (url.pathname === '/api/workspace') return json(res, {...store.syncWorkspace(value.base, value.workspace),automatic:runtimeState()});
          if (url.pathname === '/api/messages') {const message=store.sendUserMessage(value);auto?.kick();return json(res,message);}
          if (url.pathname === '/api/automatic') {if(!auto)throw new AppError('此服务未启用自动回复',409);return json(res,auto.configure(value));}
          if (url.pathname === '/api/agents/delete') {
            if(typeof value.agentId!=='string'||!value.agentId||value.agentId.length>200)throw new AppError('存档编号无效');
            const result=auto?await auto.removeAgent(value.agentId):store.deleteAgent(value.agentId);
            return json(res,{...result,automatic:runtimeState()});
          }
          if (url.pathname === '/api/disconnect') { if(auto?.state.agentId===value.agentId)auto.configure({enabled:false});store.disconnectAgent(value.agentId); return json(res, { ok: true }); }
        }
        return json(res, { error: '接口不存在' }, 404);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
      const target = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!target.startsWith(root + path.sep) || path.basename(target).startsWith('.')) return res.writeHead(403).end('Forbidden');
      let data;
      try { data = await readFile(target); } catch { return res.writeHead(404).end('Not found'); }
      res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'" });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) { json(res, { error: error.message }, error.status || 400); }
  });
  server.on('close', () => store.close());
  return { server, store, auto,
    close: async()=>{await auto?.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});},
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => {auto?.start();resolve(server.address());}); }) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createAppServer({automatic:process.env.QUILLHAVEN_AUTOREPLY!=='off'});
  const address = await app.listen();
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`Quillhaven · ${url}\n文档与聊天保存在项目的 data 目录。Ctrl+C 停止服务。`);
  if (process.argv.includes('--open') && process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore' }).on('error', () => console.log('请在浏览器中打开上方地址。'));
  let stopping=false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {if(stopping)return;stopping=true;await app.close();});
}
