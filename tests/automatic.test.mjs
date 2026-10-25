import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppServer } from '../server.mjs';
import { initialState, createDocument } from '../dist/store.js';

async function until(predicate) {
  const deadline=Date.now()+10000;
  while(!predicate()){if(Date.now()>deadline)throw new Error('等待状态超时');await delay(30);}
}
async function setup(t,Writer) {
  const dataDir=mkdtempSync(path.join(os.tmpdir(),'quillhaven-auto-'));
  const app=createAppServer({dataDir,port:0,automatic:true,runtimeOptions:{Writer}});
  const local=initialState();const doc=createDocument(local,'测试设定');doc.content='原始内容';
  app.store.migrate({id:'test-browser',workspace:local,messages:[]});
  const {port}=await app.listen();
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});});
  await until(()=>app.auto.state.phase==='ready');
  return{app,doc,url:`http://127.0.0.1:${port}`};
}
test('web messages trigger ordered automatic replies through real MCP with no polling model calls',async t=>{
  let calls=0,active=0,max=0;
  class Writer{
    constructor({callTool}){this.callTool=callTool;}
    async start(){return{model:'test-double'};}
    async reply(input){
      calls++;active++;max=Math.max(max,active);const {userMessage}=JSON.parse(input);
      await delay(50);
      const {documents}=await this.callTool('workspace_overview',{});
      const doc=await this.callTool('read_document',{id:documents[0].id});
      await this.callTool('edit_document',{id:doc.id,expectedRevision:doc.revision,edits:[{oldText:doc.content,newText:doc.content+'\n'+userMessage.content}]});
      active--;return'已记录：'+userMessage.content;
    }
    async close(){}
  }
  const{app,doc,url}=await setup(t,Writer);
  const headers={'Content-Type':'application/json','X-Quillhaven':'1'};
  for(const [id,content]of[['one','第一条'],['two','第二条']]){
    const result=await fetch(url+'/api/messages',{method:'POST',headers,body:JSON.stringify({id,content,broadcast:true})});assert.equal(result.status,200);
  }
  await until(()=>app.store.exportMessages().filter(m=>m.role==='assistant').length===2);
  const replies=app.store.exportMessages().filter(m=>m.role==='assistant');
  assert.deepEqual(replies.map(m=>m.content),['已记录：第一条','已记录：第二条']);
  assert.equal(max,1);assert.equal(calls,2);assert.equal(app.store.readDocument(doc.id).content,'原始内容\n第一条\n第二条');
  app.auto.kick();app.auto.kick();await delay(100);assert.equal(calls,2);
  await fetch(url+'/api/automatic',{method:'POST',headers,body:JSON.stringify({enabled:false})});
  await app.auto.lifecycle;
  app.store.sendUserMessage({id:'paused',content:'暂停后',broadcast:true});app.auto.kick();await delay(100);
  assert.equal(calls,2);assert.equal(app.store.snapshot().onlineAgentIds.length,0);
});
test('failed generation preserves pending message and retries only after explicit action',async t=>{
  let calls=0;
  class Writer{
    async start(){return{model:'test-double'};}
    async reply(){if(++calls===1)throw new Error('模拟断线');return'重试完成';}
    async close(){}
  }
  const{app}=await setup(t,Writer);
  app.store.sendUserMessage({id:'retry',content:'需要回复',broadcast:true});app.auto.kick();
  await until(()=>app.auto.state.phase==='error');
  assert.match(app.auto.state.error,/模拟断线/);assert.equal(app.store.exportMessages().length,1);
  app.auto.kick();await delay(100);assert.equal(calls,1);
  app.auto.configure({enabled:true,retry:true});await app.auto.lifecycle;
  await until(()=>app.store.exportMessages().length===2);
  assert.equal(calls,2);assert.equal(app.store.exportMessages()[1].content,'重试完成');
  assert.equal(app.store.nextAutomaticMessage(app.auto.state.agentId),null);
});
test('pausing an active turn prevents late reply and leaves interrupted work reviewable',async t=>{
  let rejectReply;
  class Writer{
    async start(){return{model:'test-double'};}
    reply(){return new Promise((resolve,reject)=>{rejectReply=reject;});}
    async close(){rejectReply?.(new Error('已暂停，可能已有部分编辑'));}
  }
  const{app}=await setup(t,Writer);
  app.store.sendUserMessage({id:'interrupt',content:'长任务',broadcast:true});app.auto.kick();
  await until(()=>!!rejectReply);
  app.auto.configure({enabled:false});await app.auto.lifecycle;await app.auto.running;
  assert.equal(app.store.exportMessages().length,1);
  assert.equal(app.store.nextAutomaticMessage(app.auto.state.agentId).jobStatus,'failed');
  assert.equal(app.auto.state.phase,'paused');
});

test('deleting the active identity interrupts generation, clears selection and keeps unrelated data',async t=>{
  let rejectReply;
  class Writer{
    async start(){return{model:'test-double'};}
    reply(){return new Promise((resolve,reject)=>{rejectReply=reject;});}
    async close(){rejectReply?.(new Error('身份删除，停止回复'));}
  }
  const{app,url,doc}=await setup(t,Writer),agentId=app.auto.state.agentId;
  const other=app.store.connectAgent({name:'保留伙伴'},'manual-other').agent;
  const headers={'Content-Type':'application/json','X-Quillhaven':'1'};
  let response=await fetch(url+'/api/agents/delete',{method:'POST',headers,body:JSON.stringify({agentId:other.id})});
  assert.equal(response.status,200);assert.equal(app.auto.state.phase,'ready');
  app.store.sendUserMessage({id:'delete-active',content:'正在处理的内容',recipientIds:[agentId]});app.auto.kick();
  await until(()=>!!rejectReply);
  response=await fetch(url+'/api/agents/delete',{method:'POST',headers,body:JSON.stringify({agentId})});
  assert.equal(response.status,200);
  const state=await response.json();
  assert.deepEqual(state.workspace.agents,[]);assert.deepEqual(state.onlineAgentIds,[]);
  assert.equal(state.automatic.enabled,false);assert.equal(state.automatic.phase,'paused');assert.equal(state.automatic.agentId,null);
  assert.equal(app.store.readDocument(doc.id).content,'原始内容');
  assert.equal(app.store.exportMessages().length,1);
  assert.deepEqual(app.store.getSetting('automatic'),{enabled:false,agentId:null});
  response=await fetch(url+'/api/agents/delete',{method:'POST',headers,body:JSON.stringify({agentId:null})});
  assert.equal(response.status,400);
});
