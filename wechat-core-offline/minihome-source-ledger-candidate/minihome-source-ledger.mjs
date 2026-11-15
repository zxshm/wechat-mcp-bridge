import {openSourceWindowStore} from './source-window-store.mjs';
import {registerSourceWindowTools} from './source-window-tools.mjs';
import {registerCombinedPreparation} from './minihome-combined-prepare.mjs';

// 宿主需先验证请求身份，再注册工具；所有请求共用同一个持久账本。
export function createMinihomeSourceLedger({file,roomId}){
 const store=openSourceWindowStore({file,roomId,maxEntries:100000});
 return {
  register({server,z,ownerAuthenticated,bridge,actor,inspectSubmission,inspectDirect}){
   if(ownerAuthenticated!==true||!server||typeof server.registerTool!=='function'||!z)throw Error('source_ledger_auth_required');
   registerSourceWindowTools(server,{z,store,namePrefix:'minihome_',combinedPrepare:!!bridge,storageNotice:'本工具使用中继端的独立账本，仅与当前微信连接的其他来源工具共用。其他账本或发送路径的记录需要单独核对。不得借此重试旧消息、未知结果或被拒绝操作。'});
   if(bridge){
    registerCombinedPreparation(server,{z,store,bridge,actor,inspectSubmission,inspectDirect});
    // 保持既有参数和首次资格语义，旧模板兼容；新模板必须核对完整合并证据。
    registerCombinedPreparation(server,{z,store,bridge,actor,inspectSubmission,inspectDirect,name:'minihome_prepare_verified_sync_submission'});
   }
  },
  capabilities:()=>store.capabilities(),
  get:p=>store.get(p),
  close:()=>store.close()
 };
}
