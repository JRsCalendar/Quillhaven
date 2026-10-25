import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

export class WritingTools {
  constructor(dataDir) {
    this.client=new Client({name:'quillhaven-autoreply',version:'0.3.0'});
    this.transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../mcp-server.mjs',import.meta.url))],env:{...process.env,...(dataDir?{QUILLHAVEN_DATA_DIR:dataDir}:{})},stderr:'pipe'});
  }
  async start(agentId) {
    await this.client.connect(this.transport);
    const identity=await this.call('connect_agent',agentId?{agentId}:{name:'Codex'});
    this.agent=identity.agent;
    this.tools=(await this.client.listTools()).tools;
    return identity;
  }
  async call(name,args={}) {
    const result=await this.client.callTool({name,arguments:args});
    const text=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    if(result.isError)throw new Error(text);
    return JSON.parse(text);
  }
  async close() { try{await this.call('disconnect_agent');}catch{} await this.client.close(); }
}
