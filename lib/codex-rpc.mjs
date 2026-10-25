import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export function findCodex() {
  if (process.env.QUILLHAVEN_CODEX_BIN) return process.env.QUILLHAVEN_CODEX_BIN;
  if (process.platform !== 'win32') return 'codex';
  try {
    const found = execFileSync('where.exe', ['codex'], { encoding:'utf8', windowsHide:true }).split(/\r?\n/).find(p=>p.toLowerCase().endsWith('.exe'));
    if (found && existsSync(found)) return found;
  } catch { /* The desktop app installs a private CLI. */ }
  const root = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  if (existsSync(root)) {
    const candidates = readdirSync(root).map(name=>path.join(root,name,'codex.exe')).filter(existsSync).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs);
    if (candidates[0]) return candidates[0];
  }
  throw new Error('找不到 Codex。请安装并登录 Codex，或设置 QUILLHAVEN_CODEX_BIN。');
}
export class CodexRpc extends EventEmitter {
  constructor({ cwd, args = [], onRequest } = {}) {
    super(); this.pending = new Map(); this.nextId = 1; this.closed = false;
    this.child = spawn(findCodex(), ['app-server', ...args], { cwd, windowsHide:true, stdio:['pipe','pipe','pipe'] });
    this.lines = createInterface({input:this.child.stdout});
    this.diagnostics='';
    this.child.stderr.on('data', chunk => { this.diagnostics=(this.diagnostics+chunk.toString()).slice(-4000); });
    this.child.on('error', error=>this.fail(error));
    this.child.stdin.on('error', error=>this.fail(error));
    this.child.on('exit', (code)=>{this.closed=true;this.fail(new Error(`Codex 运行进程已退出（${code}）`));this.emit('exit');});
    this.lines.on('line', async line => {
      let message; try { message=JSON.parse(line); } catch { return; }
      if (message.id !== undefined && message.method) {
        try { this.send({id:message.id,result:await onRequest?.(message.method,message.params)}); }
        catch (error) { this.send({id:message.id,error:{code:-32603,message:error.message}}); }
      } else if (message.id !== undefined) {
        const waiter=this.pending.get(message.id); if(!waiter)return;
        this.pending.delete(message.id);clearTimeout(waiter.timer);
        if(message.error)waiter.reject(new Error(message.error.message));else waiter.resolve(message.result);
      } else this.emit('notification',message);
    });
  }
  send(message) { if(!this.closed)this.child.stdin.write(JSON.stringify(message)+'\n'); }
  request(method, params={}, timeout=60000) {
    if(this.closed)return Promise.reject(new Error('Codex 已关闭'));
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${method} 等待超时`));},timeout);
      this.pending.set(id,{resolve,reject,timer});this.send({id,method,params});
    });
  }
  async initialize() {
    const result=await this.request('initialize',{clientInfo:{name:'quillhaven',title:'Quillhaven',version:'0.3.0'},capabilities:{experimentalApi:true}});
    this.send({method:'initialized',params:{}});return result;
  }
  fail(error) { for(const waiter of this.pending.values()){clearTimeout(waiter.timer);waiter.reject(error);}this.pending.clear(); }
  async close() {
    if(this.closed)return;
    this.child.stdin.end();
    await Promise.race([new Promise(resolve=>this.child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,2500))]);
    if(!this.closed){
      if(process.platform==='win32')try{execFileSync('taskkill',['/PID',String(this.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}
      else this.child.kill('SIGTERM');
    }
    this.lines.close();this.closed=true;this.fail(new Error('Codex 连接已关闭'));
  }
}
