// Opt-in isolated manual UI verification; never opens or changes the user's database.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';
import { initialState, createDocument } from '../dist/store.js';
const dataDir=mkdtempSync(path.join(os.tmpdir(),'quillhaven-preview-'));
const app=createAppServer({dataDir,port:5175,automatic:true});
const state=initialState();state.workspaceName='自动回复验证';
const doc=createDocument(state,'自动写作测试');doc.content='月亮照着海面。';
app.store.migrate({id:'ui-test',workspace:state,messages:[]});
await app.listen();console.log('隔离验证：http://127.0.0.1:5175');
let closed=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closed)return;closed=true;await app.close();rmSync(dataDir,{recursive:true,force:true});});
