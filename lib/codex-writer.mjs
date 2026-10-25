import { execFileSync } from 'node:child_process';
import { CodexRpc, findCodex } from './codex-rpc.mjs';

const disabledFeatures = ['apps','plugins','shell_tool','unified_exec','browser_use','computer_use','in_app_browser','image_generation','multi_agent'];
export class CodexWriter {
  constructor({ cwd, tools, callTool, onStatus = () => {} }) {
    this.cwd=cwd;this.tools=tools;this.callTool=callTool;this.onStatus=onStatus;this.active=null;
  }
  async start(instructions) {
    const args=disabledFeatures.flatMap(feature=>['--disable',feature]);
    // Disable inherited MCP servers only in this child; its narrowly scoped tools are proxied below.
    const configured=JSON.parse(execFileSync(findCodex(),['mcp','list','--json'],{encoding:'utf8',windowsHide:true,timeout:15000,stdio:['ignore','pipe','ignore']}));
    for(const server of configured) {
      if(!/^[\w-]+$/.test(server.name))throw new Error('MCP 配置名称包含暂不支持的字符，请使用字母、数字、下划线或短横线。');
      args.push('-c',`mcp_servers.${server.name}.enabled=false`);
      // Built-in desktop transports are synthesized by `mcp list` and may have no
      // serialized transport in a standalone app-server. Supply a disabled stub.
      if(server.transport?.type==='stdio')args.push('-c',`mcp_servers.${server.name}.command=${JSON.stringify(process.execPath)}`);
    }
    args.push('-c','project_doc_max_bytes=0','-c','web_search="disabled"');
    this.startupArgs=args;
    this.rpc=new CodexRpc({cwd:this.cwd,args,onRequest:async(method,params)=>{
      if(method!=='item/tool/call' || !this.active || !this.tools.some(t=>t.name===params.tool)) throw new Error('本写作会话只支持 Quillhaven 文档工具，其他操作未开放。');
      try {
        this.onStatus(['edit_document','create_document'].includes(params.tool)?'editing':'reading');
        const result=await this.callTool(params.tool,params.arguments);
        return {success:true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]};
      } catch(error){return{success:false,contentItems:[{type:'inputText',text:error.message}]};}
    }});
    this.rpc.on('notification',event=>this.notification(event));
    this.rpc.on('exit',()=>this.rejectActive(new Error('Codex 进程已退出，请重新连接')));
    await this.rpc.initialize();
    const auth=await this.rpc.request('account/read',{refreshToken:false});
    if(auth.account?.type!=='chatgpt')throw new Error('请先在 Codex 中登录 ChatGPT 账号。自动回复当前只使用 Codex 登录，不会改用付费 API。');
    const started=await this.rpc.request('thread/start',{
      cwd:this.cwd,environments:[],ephemeral:true,approvalPolicy:'on-request',sandbox:'read-only',
      baseInstructions:instructions,
      dynamicTools:this.tools.map(({name,description,inputSchema})=>({type:'function',name,description,inputSchema,deferLoading:false}))
    });
    this.threadId=started.thread.id;this.model=started.model;
    return {model:this.model};
  }
  notification({method,params}) {
    const active=this.active;
    if(!active || params?.threadId!==this.threadId)return;
    if(method==='item/completed' && params.item?.type==='agentMessage')active.messages.set(params.item.id,params.item);
    if(method==='turn/started')this.turnId=params.turn.id;
    if(method==='turn/completed') {
      clearTimeout(active.timer);this.active=null;this.turnId=null;
      if(params.turn.status!=='completed'){active.reject(new Error(params.turn.error?.message || '回复被中断，请检查后重试'));return;}
      const messages=[...active.messages.values()];
      const final=messages.filter(m=>m.phase==='final_answer');
      const text=(final.length?final:messages.filter(m=>m.phase!=='commentary').slice(-1)).map(m=>m.text).join('\n\n').trim();
      if(!text)active.reject(new Error('Codex 本次没有返回完整答复，请重试'));
      else active.resolve(text);
    }
  }
  async reply(text) {
    if(this.active)throw new Error('已有消息正在处理');
    let resolve,reject;
    const completion=new Promise((yes,no)=>{resolve=yes;reject=no;});
    // Attach a rejection handler before the async turn/start handshake.
    completion.catch(()=>{});
    const timer=setTimeout(()=>{this.interrupt().catch(()=>{});this.rejectActive(new Error('本次回复超过 10 分钟，已停止。请检查文档后重试。'));},600000);
    this.active={resolve,reject,messages:new Map(),timer};
    this.onStatus('thinking');
    try {const result=await this.rpc.request('turn/start',{threadId:this.threadId,input:[{type:'text',text}]});this.turnId=result.turn.id;}
    catch(error){this.rejectActive(error);}
    return completion;
  }
  rejectActive(error){if(!this.active)return;clearTimeout(this.active.timer);this.active.reject(error);this.active=null;}
  async interrupt(){if(this.turnId&&this.rpc&&!this.rpc.closed)await this.rpc.request('turn/interrupt',{threadId:this.threadId,turnId:this.turnId},5000).catch(()=>{});}
  async close(){await this.interrupt();this.rejectActive(new Error('自动回复已暂停'));await this.rpc?.close();}
}
