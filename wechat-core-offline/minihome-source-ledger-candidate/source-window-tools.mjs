import {computeSyncContentDigest} from './source-content-digest.mjs';
// 仅绑定已有鉴权下的原房间；可对原文做内存摘要计算，但不能写入正文。
export function registerSourceWindowTools(server,{z,store,storageNotice='',namePrefix='',combinedPrepare=false}){
 const sourceId=z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),number=z.number().int().nonnegative().safe();
 const answer=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
 const registerWithDigest=p=>{
  const {sourceText,...metadata}=p;
  // 新旧工具共用同一账本与摘要实现，版本名称不创建新的发送身份。
  const digest=sourceText===undefined?{}:computeSyncContentDigest(sourceText);
  return {...store.register(metadata,{contentDigest:digest.contentDigest}),...digest};
 };
 const add=(name,description,schema,read,fn)=>name==='prepare_verified_sync_submission'&&combinedPrepare?undefined:server.registerTool(namePrefix+name,{description:storageNotice+description,inputSchema:schema.strict(),annotations:{readOnlyHint:read,destructiveHint:false,openWorldHint:false}},async args=>{
  try{return answer(fn(args))}catch(e){return {isError:true,content:[{type:'text',text:/^source_[a-z_]+$/.test(e.message)?e.message:'source_storage_unavailable_read_before_retry'}]}}
 });
 add('get_sync_source_storage','读取原房间纯元数据存储能力与启用时间；不授权发送，不证明消息发布完成。',z.object({}),true,()=>store.capabilities());
 add('capture_sync_source_observation','仅保存原房间实际读到的新普通消息元数据，供首次只读历史查询使用；不是发送资格登记，不要求先证明其他路径从未发送。须核对原sourceId、作者、角色、完整原文、真实sent_at及用户同步范围。sourceCreatedAt为真实发布时间，sourceExpiresAt固定加24小时，sourceText仅内存计算UTF-8 SHA-256，不存正文。只创建独立观察记录，返回sendEligible=false和firstSubmissionClaim=false；观察不能直接预占或发送。之后用返回的不变窗口和摘要查询精确提交与直发历史；证据完整后才能调用原register_verified_sync_source登记并走原唯一预占及审批。已有登记、尝试、未知或拒绝来源不允许借此补造窗口或恢复资格，改角色、时间、摘要均拒绝。',z.object({sourceId,role:z.enum(['user','assistant','progress']),sourceCreatedAt:number,sourceExpiresAt:number,sourceText:z.string().min(1).max(8192)}),false,p=>{
  const {sourceText,...metadata}=p,digest=computeSyncContentDigest(sourceText);
  return {...store.observe({...metadata,contentDigest:digest.contentDigest}),...digest};
 });
 add('get_sync_source_window','读取首次保存的固定时间窗口、尝试状态及预占前保存的submission请求元数据；submission=null表示旧记录没有保存，禁止据此猜补原eventId。元数据只用于核查，读取不恢复首次资格、不授权重发。查无记录只代表本账本未登记，不证明其他路径未发送。',z.object({sourceId}),true,p=>store.get(p));
 add('list_pending_sync_sources','分页读取本房间已观察但未预占的持久元数据，供恢复遗漏核查。每轮从空游标开始，按sourceId稳定排序读至hasMore=false，再按真实发布时间处理。列表不证明从未发送或发送资格，已知拒绝仍禁止重试；必须重新读取原消息与真实发送记录，不能凭列表发送。无正文，不调用微信。',z.object({afterSourceId:sourceId.nullable().optional(),limit:z.number().int().min(1).max(100).optional()}),true,p=>store.listPending(p));
 add('prepare_verified_sync_submission','把已观察新来源的登记、固定请求元数据和唯一首次预占合为一个原子事务，减少分步遗漏。调用前必须实际读取原房间并核验原sourceId、角色、完整原文、真实发布时间、固定24小时窗口、完整发送历史、其他写者与有效本人会话。原观察窗口与摘要必须一致；sourceText只计算摘要，不保存正文。与本服务的登记和预占工具共用账本，不能恢复旧未知、拒绝或已尝试来源资格。只有本次acquired=true且firstSubmissionClaim=true可继续原enqueue首次请求，仍需原平台审批；读取、重复调用和丢失响应不能恢复资格。本工具不发送微信。',z.object({sourceId,role:z.enum(['user','assistant','progress']),sourceCreatedAt:number,sourceExpiresAt:number,eventId:sourceId,sourceText:z.string().min(1).max(8192)}),false,p=>{
  const {sourceText,...metadata}=p,digest=computeSyncContentDigest(sourceText);
  return {...store.prepareVerifiedSubmission({...metadata,contentDigest:digest.contentDigest}),...digest};
 });
 add('register_sync_source_window','仅为启用时间之后、经原房间真实消息和用户同步授权核验且尚未尝试的新普通消息登记。唯一后台处理者可自行读取核验，不要求发布运行额外声明交接；提醒本身不证明来源或首次资格。使用与微信同步接口完全相同的稳定 sourceId、原始角色和真实 sent_at 毫秒；截止固定为创建后24小时。可传 sourceText 为完整原文（UTF-8最多8192字节），用Node内置加密库在内存计算并返回 contentDigest，可直接供提交查询使用，不必另找命令行或手写SHA-256。原文不裁剪、不规范化、不保存；摘要不证明来源真实，仍须读取核验。成功响应 durableReadBack=true 的 record 已由提交成功的数据库事务保存并读回，核对返回值即可继续查询/提交，无需再单独 get；响应未知时才读取对账。之后始终复用原窗口。不得回填旧未知消息。只存元数据，不发送。',z.object({sourceId,role:z.enum(['user','assistant','progress']),sourceCreatedAt:number,sourceExpiresAt:number,sourceText:z.string().min(1).max(8192).optional()}),false,p=>{
  return registerWithDigest(p);
 });
 add('register_sync_source_window_v2','新版固定来源登记与内置摘要接口，明确要求 sourceText，避免同名旧定义缺少可选字段。仅为启用后、经原房间真实消息和用户同步授权核验且未尝试的新来源登记。唯一后台处理者可自行读取核验，不要求发布运行额外声明交接；提醒本身不证明来源或首次资格。sourceId、role 和真实 sent_at 毫秒保持原样，sourceExpiresAt 固定为创建后24小时。sourceText 必须为核验后的完整原文，UTF-8最多8192字节；内存计算 SHA-256，不裁剪、不规范化、不保存正文。返回 contentDigest、durableReadBack 和同一原账本 record。与本服务的其他登记接口共用身份和唯一预占；不得换身份或时间窗绕过未知、已尝试或已发送状态。登记不发送微信、不证明其他路径没有发送；仍须核验原始消息与授权、发送记录及其他写者，再由原处理器预占一次。',z.object({sourceId,role:z.enum(['user','assistant','progress']),sourceCreatedAt:number,sourceExpiresAt:number,sourceText:z.string().min(1).max(8192)}),false,p=>({...registerWithDigest(p),schemaVersion:2}));
 // 新名称使平台发现修正后的自动核验语义；仍调用同一登记实现和原账本。
 add('register_verified_sync_source','登记用户已授权同步的原房间新普通消息。唯一后台处理者须直接读取原房间，核实原始sourceId、作者、完整原文、真实sent_at、固定24小时时间窗、既有发送记录、其他写者和有效本人上下文；不要求发布运行另写交接声明，提醒或队列为空均不能证明首次资格。sourceText只在内存计算SHA-256，不保存正文。与本服务的register_sync_source_window及v2共用账本、来源身份和唯一预占；已有未知、已尝试、已发送项均不能通过改工具名恢复资格。返回contentDigest、durableReadBack和原record；此工具不发送微信，不替代安全审批。',z.object({sourceId,role:z.enum(['user','assistant','progress']),sourceCreatedAt:number,sourceExpiresAt:number,sourceText:z.string().min(1).max(8192)}),false,p=>({...registerWithDigest(p),schemaVersion:3}));
 add('reserve_sync_source_attempt','仅在核验新来源、原文、有效本人上下文、首次窗口及其他写者协调后，在第一次 enqueue 前原子预占。本次明确 acquired=true 且 firstSubmissionClaim=true 表示当前调用取得唯一首次提交资格，仍不代替用户授权、来源核验或安全审批。record.phase=reserved_unknown 是预先持久保存的保守状态，不证明已经调用 transport；retrySendAllowed=false 始终禁止第二次尝试。本次成功响应之外的任何读取、重连、丢失响应或 acquired=false 均不提供首次提交资格，只读对账。不得重新预占、重发、换路径或绕过审批拒绝。此账本不控制其他发送路径。',z.object({sourceId,revision:number}),false,p=>store.reserve(p));
 add('reserve_sync_source_attempt_v2','新版首次预占：仅用于已登记且从未预占的新普通来源。先把核验后的原微信eventId、完整sourceText的内置SHA-256、固定微信连接及已登记的原身份/角色/时间窗持久保存，再取得唯一首次资格；正文不落盘，无须增加单独准备调用。必须核对返回submission与拟提交请求一致；元数据不证明来源或微信上下文真实，仍须先核验。原eventId与摘要一经准备不可更改，旧已尝试项缺少元数据时禁止猜补。与本服务的其他预占工具共用账本；仅本次acquired=true及firstSubmissionClaim=true允许继续按已有授权尝试首次enqueue。读取、重复预占、重启均不恢复资格；retrySendAllowed=false，不授权自动恢复、重发或绕过审批。',z.object({sourceId,revision:number,eventId:sourceId,sourceText:z.string().min(1).max(8192)}),false,p=>{
  const digest=computeSyncContentDigest(p.sourceText);
  store.prepareSubmission({sourceId:p.sourceId,revision:p.revision,eventId:p.eventId,contentDigest:digest.contentDigest});
  return {...store.reservePrepared({sourceId:p.sourceId,revision:p.revision}),...digest,schemaVersion:2};
 });
 add('record_sync_source_result','根据真实提交/对账工具结果保存状态；不发送。sent 是调用者报告的工具结果，不独立证明 transport 或手机送达。所有状态禁止再预占；unknown 保留 reserved_unknown，仅做读取对账。',z.object({sourceId,outcome:z.enum(['queued','inflight','sent','uncertain','failed','expired'])}),false,p=>store.finish(p));
}
