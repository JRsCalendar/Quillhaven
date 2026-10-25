import { api } from './local-api.js';

export function setupAutomatic({getAgents,notify}) {
  const status=document.querySelector('#automatic-status'),toggle=document.querySelector('#toggle-automatic'),notice=document.querySelector('#composer-notice');
  let state={enabled:false,phase:'connecting'},busy=false;
  const labels={connecting:'正在连接',ready:'自动回复已就绪',thinking:'正在思考',reading:'正在查阅',editing:'正在编辑文档',paused:'自动回复已暂停',error:'自动回复遇到问题'};
  function render() {
    status.textContent=`${state.agentName||'Codex'} · ${labels[state.phase]||'自动回复不可用'}`;
    status.dataset.phase=state.phase;
    status.title=state.model?`当前模型：${state.model}`:'';
    toggle.textContent=state.phase==='error'?'重试':state.enabled?'暂停':'开启';
    toggle.disabled=busy || state.phase==='unavailable';
    toggle.setAttribute('aria-pressed',String(!!state.enabled));
    const selected=document.querySelector('#chat-recipient').value;
    const mismatch=selected!=='all' && selected!==state.agentId;
    notice.textContent=state.phase==='error' ? state.error : !state.enabled ? '自动回复已暂停，消息会保留。' : mismatch ? '这个伙伴尚未自动接入；可在它的存档中启用。' : '直接发送即可，伙伴会自动读取并回复。';
  }
  window.addEventListener('quillhaven-automatic',event=>{state=event.detail||{enabled:false,phase:'unavailable'};render();});
  window.addEventListener('quillhaven-offline',()=>{state={...state,phase:'error',error:'本机服务已停止，重新启动项目后即可继续。'};render();});
  document.querySelector('#chat-recipient').addEventListener('change',render);
  async function configure(value) {
    if(busy)return;
    busy=true;render();
    try{state=await api('automatic',value);render();}catch(error){notify(error.message);}finally{busy=false;render();}
  }
  toggle.onclick=()=>{
    const selected=document.querySelector('#chat-recipient').value;
    const candidate=selected!=='all'?selected:state.agentId||getAgents().find(a=>a.name==='Codex')?.id||null;
    configure({enabled:state.phase==='error'||!state.enabled,agentId:candidate,retry:state.phase==='error'});
  };
  render();
  return {activate:agentId=>configure({enabled:true,agentId,retry:true})};
}
