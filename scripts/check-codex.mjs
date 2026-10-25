import { CodexRpc } from '../lib/codex-rpc.mjs';
const rpc=new CodexRpc({onRequest:async()=>{throw new Error('诊断模式不执行工具');}});
try {
  await rpc.initialize();
  const result=await rpc.request('account/read',{refreshToken:false});
  console.log(JSON.stringify({loggedIn:!!result.account,authType:result.account?.type,requiresOpenaiAuth:result.requiresOpenaiAuth}));
  const models=await rpc.request('model/list',{limit:10});
  console.log(JSON.stringify({models:models.data.map(m=>({model:m.model,isDefault:m.isDefault}))}));
} finally {await rpc.close();}
