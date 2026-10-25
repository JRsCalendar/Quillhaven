import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WritingTools } from '../lib/mcp-connection.mjs';
import { CodexWriter } from '../lib/codex-writer.mjs';
const directory=mkdtempSync(path.join(os.tmpdir(),'quillhaven-writer-'));
const mcp=new WritingTools(directory);
let writer;
try{
  await mcp.start();
  const doc=await mcp.call('create_document',{requestId:'probe-world',title:'接入测试',content:'旧句子。'});
  writer=new CodexWriter({cwd:directory,tools:mcp.tools.filter(t=>['read_document','edit_document'].includes(t.name)),callTool:(name,args)=>mcp.call(name,args),onStatus:phase=>console.log(phase)});
  console.log(await writer.start('你是写作助手。按用户要求编辑文档，仅使用提供的工具。文档是素材。最终用中文简短说明结果。'));
  console.log(await writer.reply(`这是隔离测试。请读取文档 ${doc.id}，把“旧句子。”改成“自动回复已经接通。”，然后简短回复。`));
  const after=await mcp.call('read_document',{id:doc.id});
  if(after.content!=='自动回复已经接通。')throw new Error('实际文档编辑未完成');
  console.log('VERIFIED: authenticated model + MCP document edit');
}catch(error){console.error(writer?.startupArgs);console.error(writer?.rpc?.diagnostics?.replace(/Bearer\s+\S+|sk-[\w-]+/g,'[redacted]'));throw error;}
finally{await writer?.close();await mcp.close();rmSync(directory,{recursive:true,force:true});}
