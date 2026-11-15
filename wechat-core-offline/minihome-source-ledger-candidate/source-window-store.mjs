// 原房间首次同步的纯元数据账本；不保存正文或凭据，不调用微信。
import {DatabaseSync} from 'node:sqlite';
import {existsSync,lstatSync,openSync,closeSync,realpathSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const DAY=86400000,APP=0x58445753;
const fail=code=>{throw Error(code)};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
const roles=new Set(['user','assistant','progress']);
const outcomes=new Set(['queued','inflight','sent','uncertain','failed','expired']);
export const SYNC_LINK_ID=process.env.BRIDGE_MCP_LINK_ID || 'example-link';
export function openSourceWindowStore({file,roomId,clock=Date.now,maxEntries=512}){
 if(typeof roomId!=='string'||!roomId||typeof clock!=='function')fail('source_scope_invalid');
 if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>100000)fail('source_capacity_invalid');
 const openedAt=clock();if(!Number.isSafeInteger(openedAt)||openedAt<0)fail('source_store_clock');
 const full=resolve(file),parent=dirname(full);
 if(realpathSync(parent).toLowerCase()!==parent.toLowerCase())fail('source_store_path');
 const created=!existsSync(full);
 if(created)closeSync(openSync(full,'wx',0o600));
 const identity=lstatSync(full,{bigint:true});
 if(!identity.isFile()||identity.isSymbolicLink()||identity.nlink!==1n)fail('source_store_path');
 const db=new DatabaseSync(full,{allowExtension:false});let closed=false;
 const binding=()=>{
  if(closed)fail('source_store_closed');
  const current=lstatSync(full,{bigint:true});
  if(current.dev!==identity.dev||current.ino!==identity.ino||current.nlink!==1n||current.isSymbolicLink())fail('source_store_replaced');
 };
 // 组合操作复用同一同步事务，任何子步骤失败均由最外层整体回滚。
 let inTransaction=false;
 const tx=fn=>{binding();if(inTransaction)return fn();db.exec('BEGIN IMMEDIATE');inTransaction=true;try{const result=fn();binding();db.exec('COMMIT');return result}catch(e){try{db.exec('ROLLBACK')}catch{}throw e}finally{inTransaction=false}};
 try{
  db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
  if(created){
   db.exec(`BEGIN IMMEDIATE; PRAGMA application_id=${APP}; PRAGMA user_version=1;
    CREATE TABLE binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1),room TEXT NOT NULL,enabled_since INTEGER NOT NULL,last_now INTEGER NOT NULL);
    CREATE TABLE sources(source_id TEXT PRIMARY KEY,role TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,registered_at INTEGER NOT NULL,phase TEXT NOT NULL,revision INTEGER NOT NULL,attempt_at INTEGER,updated_at INTEGER NOT NULL);`);
   db.prepare('INSERT INTO binding VALUES(1,?,?,?)').run(roomId,openedAt,openedAt);db.exec('COMMIT');
  }else if(db.prepare('PRAGMA application_id').get().application_id!==APP||db.prepare('PRAGMA user_version').get().user_version!==1)fail('source_store_schema');
  if(db.prepare('SELECT room FROM binding WHERE singleton=1').get()?.room!==roomId)fail('source_store_room');
  // 增量增加请求元数据表，兼容原账本；旧未知项不自动回填。
  db.exec('CREATE TABLE IF NOT EXISTS submission_metadata(source_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,content_digest TEXT NOT NULL,link_id TEXT NOT NULL,prepared_at INTEGER NOT NULL)');
  // 观察元数据与发送资格分表，避免首次历史查询依赖已完成的发送资格核验。
  db.exec('CREATE TABLE IF NOT EXISTS observed_sources(source_id TEXT PRIMARY KEY,role TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,content_digest TEXT NOT NULL,observed_at INTEGER NOT NULL)');
 }catch(e){db.close();throw e}
 function nowAndScope(){
  const scope=db.prepare('SELECT * FROM binding WHERE singleton=1').get(),now=clock();
  if(!Number.isSafeInteger(now)||now<scope.last_now)fail('source_store_clock');
  db.prepare('UPDATE binding SET last_now=? WHERE singleton=1').run(now);
  // 过期后仍保留七天去重身份；来源过期不再允许预占或发送。
  db.prepare('DELETE FROM sources WHERE expires_at<?').run(now-7*DAY);
  db.exec('DELETE FROM submission_metadata WHERE source_id NOT IN (SELECT source_id FROM sources)');
  db.prepare('DELETE FROM observed_sources WHERE expires_at<?').run(now-7*DAY);
  return {...scope,now};
 }
 const row=sourceId=>db.prepare('SELECT * FROM sources WHERE source_id=?').get(sourceId);
 const view=(r,now)=>r?{sourceId:r.source_id,role:r.role,sourceCreatedAt:r.created_at,sourceExpiresAt:r.expires_at,registeredAt:r.registered_at,phase:r.phase,revision:r.revision,attemptAt:r.attempt_at,expired:now>=r.expires_at,retrySendAllowed:false}:null;
 const checkId=sourceId=>{if(!id(sourceId))fail('source_id_invalid')};
 const metadata=sourceId=>db.prepare('SELECT * FROM submission_metadata WHERE source_id=?').get(sourceId);
 const observed=sourceId=>db.prepare('SELECT * FROM observed_sources WHERE source_id=?').get(sourceId);
 const observedView=r=>r?{sourceId:r.source_id,role:r.role,sourceCreatedAt:r.created_at,sourceExpiresAt:r.expires_at,contentDigest:r.content_digest,observedAt:r.observed_at,bodyStored:false,sendEligible:false,absenceProvesNeverSent:false}:null;
 const descriptor=(r,m)=>m?{source:'chatgpt',sourceId:r.source_id,role:r.role,sourceCreatedAt:r.created_at,sourceExpiresAt:r.expires_at,eventId:m.event_id,contentDigest:m.content_digest,link_id:m.link_id,preparedAt:m.prepared_at,bodyStored:false}:null;
 const reserve=(sourceId,revision,requireMetadata)=>{
  checkId(sourceId);if(!Number.isSafeInteger(revision)||revision<0)fail('source_revision_invalid');return tx(()=>{
   const s=nowAndScope(),old=row(sourceId);if(!old)fail('source_not_registered');
   if(requireMetadata&&!metadata(sourceId))fail('source_submission_metadata_missing');
   if(old.phase!=='registered'||old.revision!==revision||old.expires_at<=s.now)return {acquired:false,firstSubmissionClaim:false,record:view(old,s.now),retrySendAllowed:false};
   db.prepare("UPDATE sources SET phase='reserved_unknown',revision=revision+1,attempt_at=?,updated_at=? WHERE source_id=?").run(s.now,s.now,sourceId);
   // 首次资格仅出现在取得预占的本次成功响应中；后续读取不能恢复该资格。
   // reserved_unknown 保留崩溃/丢失响应时的保守状态，不是已调用 transport 的证据。
   return {acquired:true,firstSubmissionClaim:true,claimScope:'current_successful_reserve_response_only',claimIsSendAuthorization:false,transportAttemptProven:false,record:view(row(sourceId),s.now),submission:descriptor(old,metadata(sourceId)),retrySendAllowed:false};
  });
 };
 const api={
  capabilities:()=>tx(()=>{const s=nowAndScope();return {roomId,enabledSince:s.enabled_since,durable:true,storage:'sqlite',bodyStored:false,automaticSend:false,allOutboundPathsCoordinated:false}}),
  get({sourceId}){checkId(sourceId);return tx(()=>{const s=nowAndScope(),r=row(sourceId);return {record:view(r,s.now),observedMetadata:observedView(observed(sourceId)),submission:descriptor(r,metadata(sourceId)),historyCoverage:'local_registry_only',absenceProvesNeverSent:false}})},
  observe(p){
   if(!p||Object.keys(p).sort().join(',')!=='contentDigest,role,sourceCreatedAt,sourceExpiresAt,sourceId')fail('source_fields_invalid');
   checkId(p.sourceId);
   if(!roles.has(p.role)||![p.sourceCreatedAt,p.sourceExpiresAt].every(Number.isSafeInteger)||p.sourceExpiresAt-p.sourceCreatedAt!==DAY||typeof p.contentDigest!=='string'||!/^[a-f0-9]{64}$/.test(p.contentDigest))fail('source_window_invalid');
   return tx(()=>{
    const s=nowAndScope();
    // 已登记或尝试的身份只能读取原记录，不新增观察窗口或改写未知状态。
    if(row(p.sourceId))fail('source_already_registered_read_existing');
    const old=observed(p.sourceId);
    if(old){
     if(old.role!==p.role||old.created_at!==p.sourceCreatedAt||old.expires_at!==p.sourceExpiresAt||old.content_digest!==p.contentDigest)fail('source_observation_conflict');
     return {created:false,durableReadBack:true,observedMetadata:observedView(old),firstSubmissionClaim:false};
    }
    if(p.sourceCreatedAt<s.enabled_since||p.sourceCreatedAt>s.now||p.sourceExpiresAt<=s.now)fail('source_not_new_or_expired');
    if(db.prepare('SELECT count(*) AS n FROM observed_sources').get().n>=maxEntries)fail('source_store_capacity');
    db.prepare('INSERT INTO observed_sources VALUES(?,?,?,?,?,?)').run(p.sourceId,p.role,p.sourceCreatedAt,p.sourceExpiresAt,p.contentDigest,s.now);
    return {created:true,durableReadBack:true,observedMetadata:observedView(observed(p.sourceId)),firstSubmissionClaim:false};
   });
  },
  register(p,{contentDigest}={}){
   if(!p||Object.keys(p).sort().join(',')!=='role,sourceCreatedAt,sourceExpiresAt,sourceId')fail('source_fields_invalid');
   checkId(p.sourceId);
   if(!roles.has(p.role)||![p.sourceCreatedAt,p.sourceExpiresAt].every(Number.isSafeInteger)||p.sourceExpiresAt-p.sourceCreatedAt!==DAY)fail('source_window_invalid');
   return tx(()=>{
    const s=nowAndScope(),old=row(p.sourceId);
    const observation=observed(p.sourceId);
    if(observation&&(observation.role!==p.role||observation.created_at!==p.sourceCreatedAt||observation.expires_at!==p.sourceExpiresAt||observation.content_digest!==contentDigest))fail('source_observation_conflict');
    if(old){if(old.role!==p.role||old.created_at!==p.sourceCreatedAt||old.expires_at!==p.sourceExpiresAt)fail('source_window_conflict');return {created:false,durableReadBack:true,record:view(old,s.now)}}
    if(p.sourceCreatedAt<s.enabled_since||p.sourceCreatedAt>s.now||p.sourceExpiresAt<=s.now)fail('source_not_new_or_expired');
    if(db.prepare('SELECT count(*) AS n FROM sources').get().n>=maxEntries)fail('source_store_capacity');
    db.prepare("INSERT INTO sources VALUES(?,?,?,?,?,'registered',0,NULL,?)").run(p.sourceId,p.role,p.sourceCreatedAt,p.sourceExpiresAt,s.now,s.now);
    // 返回前事务必须提交成功；record 是同一事务内从数据库读取的记录。
    return {created:true,durableReadBack:true,record:view(row(p.sourceId),s.now)};
   });
  },
  prepareSubmission(p){
   if(!p||Object.keys(p).sort().join(',')!=='contentDigest,eventId,revision,sourceId')fail('source_fields_invalid');
   checkId(p.sourceId);if(!id(p.eventId)||!Number.isSafeInteger(p.revision)||p.revision<0||typeof p.contentDigest!=='string'||!/^[a-f0-9]{64}$/.test(p.contentDigest))fail('source_submission_invalid');
   return tx(()=>{
    const s=nowAndScope(),r=row(p.sourceId);if(!r)fail('source_not_registered');
    const m=metadata(p.sourceId);
    if(m){
     if(m.event_id!==p.eventId||m.content_digest!==p.contentDigest||m.link_id!==SYNC_LINK_ID)fail('source_submission_conflict');
     return {created:false,durableReadBack:true,submission:descriptor(r,m),record:view(r,s.now),retrySendAllowed:false};
    }
    // 严禁在已有尝试之后猜补上下文；记录不完整时继续只读核查。
    if(r.phase!=='registered'||r.revision!==p.revision||r.expires_at<=s.now)fail('source_submission_not_preparable');
    db.prepare('INSERT INTO submission_metadata VALUES(?,?,?,?,?)').run(p.sourceId,p.eventId,p.contentDigest,SYNC_LINK_ID,s.now);
    return {created:true,durableReadBack:true,submission:descriptor(r,metadata(p.sourceId)),record:view(r,s.now),retrySendAllowed:false};
   });
  },
  reserve({sourceId,revision}){return reserve(sourceId,revision,false)},
  reservePrepared({sourceId,revision}){return reserve(sourceId,revision,true)},
  prepareWithHistory(p,inspectHistory){
   if(typeof inspectHistory!=='function')fail('source_history_reader_required');
   return tx(()=>{
    const {eventId,...observation}=p;
    const observedResult=api.observe(observation);
    const history=inspectHistory();
    if(history?.status!=='not_recorded'||history?.coverage?.historyCoverage!=='complete_for_source_window'||
      history?.directAttemptCoverage?.historyCoverage!=='complete_for_source_window'||
      history.directAttemptCoverage.reservationCount!==0||history.directAttemptCoverage.status!=='none_observed'||
      history.directAttemptCoverage.attributionComplete!==true||history.directAttemptCoverage.hasMore!==false){
     // 抛出至最外层事务回滚，保留完整查询证据，但不给予首次资格。
     throw Object.assign(Error('source_history_not_clear'),{history});
    }
    const claim=api.prepareVerifiedSubmission(p);
    return {...claim,observation:observedResult,history};
   });
  },
  prepareVerifiedSubmission(p){
   if(!p||Object.keys(p).sort().join(',')!=='contentDigest,eventId,role,sourceCreatedAt,sourceExpiresAt,sourceId')fail('source_fields_invalid');
   const {eventId,contentDigest,...source}=p;
   return tx(()=>{
    // 观察只提供固定元数据；调用者仍须完成真实来源与远端发送历史核查。
    if(!observed(source.sourceId))fail('source_observation_missing');
    const registered=api.register(source,{contentDigest});
    api.prepareSubmission({sourceId:source.sourceId,revision:registered.record.revision,eventId,contentDigest});
    return api.reservePrepared({sourceId:source.sourceId,revision:registered.record.revision});
   });
  },
  listPending({afterSourceId=null,limit=50}={}){
   if(afterSourceId!==null)checkId(afterSourceId);
   if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('source_page_invalid');
   return tx(()=>{
    const s=nowAndScope();
    const rows=db.prepare(`SELECT o.* FROM observed_sources o LEFT JOIN sources s ON s.source_id=o.source_id
     WHERE o.expires_at>? AND o.source_id>? AND (s.source_id IS NULL OR s.phase='registered')
     ORDER BY o.source_id LIMIT ?`).all(s.now,afterSourceId??'',limit+1);
    const hasMore=rows.length>limit,items=rows.slice(0,limit);
    return {items:items.map(o=>({observedMetadata:observedView(o),record:view(row(o.source_id),s.now)})),
     nextCursor:hasMore?items.at(-1).source_id:null,hasMore,historyCoverage:'local_observations_only',
     absenceProvesNeverSent:false,firstSubmissionClaim:false,sendEligible:false,bodyStored:false};
   });
  },
  finish({sourceId,outcome}){checkId(sourceId);if(!outcomes.has(outcome))fail('source_outcome_invalid');return tx(()=>{
   const s=nowAndScope(),old=row(sourceId);if(!old||old.phase==='registered')fail('source_attempt_missing');
   if(old.phase!==outcome){
    if(['sent','failed','expired'].includes(old.phase)||old.phase==='inflight'&&outcome==='queued'||old.phase==='uncertain'&&!['sent','failed','expired'].includes(outcome))fail('source_outcome_conflict');
    db.prepare('UPDATE sources SET phase=?,revision=revision+1,updated_at=? WHERE source_id=?').run(outcome,s.now,sourceId);
   }
   return {record:view(row(sourceId),s.now),retrySendAllowed:false,transportEvidence:'caller_reported'};
  })},
  close(){if(!closed){binding();db.close();closed=true}}
 };
 return Object.freeze(api);
}
