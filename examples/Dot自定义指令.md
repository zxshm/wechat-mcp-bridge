# Dot 自定义指令与固定同步程序

先配置自己的聊天、连接、作者和实际任务。所有值从当前原聊天与任务的真实读取结果取得，任务版本变化后核查职责并更新配置。任务列表按实际存在的写者填写，长度可变。

## 配置方法

下面是配置结构。工具名称取决于客户端，`dot-sync-pair.mjs` 中的 `n` 映射对应当前宿主的消息读取、任务读取及微信 MCP 工具。

```javascript
{
  roomId: '填写原聊天 room_id',
  linkId: '填写当前微信 MCP link_id',
  ownerAuthorId: '填写本人 author_id',
  assistantAuthorId: '填写小弟 author_id',
  writers: [
    ['填写当前接收任务 ID', true, '填写回读得到的 contextVersion'],
    ['填写已停用旧监听 ID', false, '填写回读得到的 contextVersion']
  ]
}
```

## 自定义指令正文

将下面的规则、填好的配置和本文件末尾的完整程序保存到原聊天自定义指令。

> 本聊天的新普通问答需要同步到已绑定的本人微信。先发布正常回答并保留真实 message_id，然后执行固定同步程序，读取本轮真实问题与回答并按顺序入队。同步成功时静默完成。
>
> 固定程序完整保存于此，运行缓存只作加速。缓存缺失时，从此处恢复完整程序，在一次连续执行中完整等待结果。外层只传原问题 ID、已发布回答 ID、当前同步范围声明和已经核验的配置，程序负责内部读取及准备。已有本人事件和近期游标可选传入，缺失时程序从保留记录重建索引。
>
> 配置中的聊天、作者、微信连接及任务职责保持一致。程序核对真实来源、本人事件、固定时间窗、历史、唯一预占和回执。执行开始后保存返回上下文及分段计时，已有未知或拒绝项沿原身份查询。
>
> 微信接收任务负责微信新事件。核验本人来信后，在原聊天显示“微信·你：”原文，生成真实回复，以 owner-reply-v1-<原eventId> 为固定键首次调用 send_wechat_reply 并等待最终结果，再显示“微信·小弟：”及真实状态。查询未匹配记录的 unknown 按覆盖范围理解，首次发送是否已经发生以实际执行记录判断。微信镜像与已发送回复保持原方向记录，避免再次触发客户端同步。
>
> 图片和文件走媒体工具。云端生成的大文件取得原始字节及 SHA-256 后，begin_large_wechat_file_upload 创建上传，在可执行 HTTPS 的环境中使用原始二进制上传及续传，finish 完整校验，再 send_large_wechat_file_upload 首次发送。具体附件来源、原会话和结果保持关联。

调用示例中的 configuration 必须替换为上面填好的对象。

```javascript
const result = await syncPair(tools, {
  configuration,
  questionId,
  answerId,
  ordinaryAuthorizedTurn: true,
  // 可选，已有真实索引时传入。
  eventId,
  conversationCursor
});
```

普通短文字模板包含 8192 字节服务端核验限制，复杂任务、超长正文和附件需要对应流程。源码及测试位于同目录，`node --test examples/dot-sync-pair.test.mjs` 可运行合成编排验证。

## 持久执行源码

```javascript
async function syncPair(tools, input) {
  const { questionId, answerId, ordinaryAuthorizedTurn, conversationCursor } = input;
  let eventId = input.eventId;
  const configuration = input.configuration;
  if (!configuration || !['roomId','linkId','ownerAuthorId','assistantAuthorId'].every(key =>
      typeof configuration[key] === 'string' && configuration[key]) ||
      !Array.isArray(configuration.writers) || !configuration.writers.length ||
      !configuration.writers.every(row => Array.isArray(row) && row.length === 3 &&
        typeof row[0] === 'string' && typeof row[1] === 'boolean' && typeof row[2] === 'string'))
    throw new Error('需要填写并核验本人的聊天、连接、作者与任务配置');
  const { roomId, linkId, ownerAuthorId, assistantAuthorId, writers } = configuration;
  const trace = [];
  const errors = [];
  const startedAt = Date.now();
  const states = new Set(['queued', 'inflight', 'sent']);

  // 不输出正文、凭证或 URL。原错误可能含敏感数据，
  // 只保留工具名、isError、错误类别及脱敏后的短理由。
  function safeError(tool, r) {
    // 只输出受限错误代码，不回显原正文、URL 或任意异常对象。
    let data = r?.structuredContent;
    const raw = r?.content?.find(x => x.type === 'text')?.text;
    if (!data && typeof raw === 'string') {
      try { data = JSON.parse(raw); } catch { data = { error_code: raw }; }
    }
    const candidate = data?.error_code ?? data?.error?.code ?? data?.code ?? data?.error;
    const rpcInternal = candidate === -32603 || (typeof raw === 'string' && raw.length <= 2048 &&
      /^(?:tool call error: tool call failed for `[A-Za-z0-9_./]+`\s+Caused by:\s+)?Mcp error: -32603: Internal error\s*$/.test(raw));
    const code = rpcInternal ? -32603 : typeof candidate === 'string' && /^[a-z][a-z0-9_]{2,80}$/.test(candidate)
      ? candidate : null;
    return { tool, isError: r?.isError === true, code,
      reason: rpcInternal ? 'MCP 内部错误' : code || '原错误类别或短理由缺失；未输出原始敏感内容' };
  }
  async function invoke(name, args) {
    const s = Date.now();
    let status = 'error';
    try {
      const r = await tools[name](args);
      if (r?.isError) throw safeError(name, r);
      let value = r?.structuredContent;
      if (value == null) {
        const raw = r?.content?.find(x => x.type === 'text')?.text;
        if (typeof raw !== 'string') throw new Error('结果缺失');
        value = JSON.parse(raw);
      }
      status = 'ok';
      return value;
    } catch (err) {
      const error = err?.tool === name && typeof err?.reason === 'string'
        ? { tool: name, isError: err.isError === true, code: err.code ?? null, reason: err.reason }
        : { tool: name, isError: false, code: null, reason: '调用或结果解析失败；原异常未回显' };
      errors.push(error);
      throw error;
    } finally {
      trace.push({ tool: name, start: s, end: Date.now(), status });
    }
  }
  const n = {
    read: 'mcp__codex_apps__user_message_read_messages',
    task: 'mcp__codex_apps__automations_get',
    recent: 'mcp__codex_apps__mcp_list_recent_wechat_conversation',
    event: 'mcp__codex_apps__mcp_get_wechat_event',
    prepare: 'mcp__codex_apps__mcp_minihome_prepare_verified_sync_submission',
    enqueue: 'mcp__codex_apps__mcp_enqueue_chatgpt_sync_message',
    record: 'mcp__codex_apps__mcp_minihome_record_sync_source_result'
  };
  const result = { startedAt, trace, errors, sources: {} };
  const fail = (where, reason) => ({ ...result, stoppedAt: where, reason });

  // 仅恢复明确内部错误的只读查询；不重试预占、发送、审批拒绝或未知错误。
  const readRecent = async () => {
    const bootstrap = !eventId || !conversationCursor;
    let cursor = bootstrap ? null : conversationCursor;
    const entries = [], seen = new Set();
    for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
      const args = { link_id: linkId, after: cursor, limit: 50 };
      let page;
      try { page = await invoke(n.recent, args); }
      catch (error) {
        if (error.code !== -32603 || result.readRecovery) throw error;
        result.readRecovery = { tool: n.recent, attempts: 2, recovered: false };
        page = await invoke(n.recent, args);
        result.readRecovery.recovered = true;
      }
      if (!Array.isArray(page.entries) || typeof page.resumeCursor !== 'string')
        throw new Error('近期记录字段缺失');
      entries.push(...page.entries);
      result.contextBootstrap = { used: bootstrap, pages: pageNumber };
      if (!page.nextCursor) return { ...page, entries, nextCursor: null };
      if (typeof page.nextCursor !== 'string' || seen.has(page.nextCursor))
        throw new Error('近期记录分页循环');
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error('近期记录分页未完整覆盖');
  };

  if ((input.roomId !== undefined && input.roomId !== roomId) ||
      (input.linkId !== undefined && input.linkId !== linkId))
    return fail('scope', '仅允许原小弟与原微信连接');
  if (![questionId, answerId].every(x => typeof x === 'string' && x) ||
      [eventId, conversationCursor].some(x => x != null && (typeof x !== 'string' || !x)))
    return fail('input', '必要身份字段缺失');
  if (questionId === answerId) return fail('input', '来源 ID 冲突');
  // 此标记只声明调用方已按当前用户意图确认普通本轮范围；不代替下面的实际核验。
  if (ordinaryAuthorizedTurn !== true)
    return fail('scope', '当前运行未确认本轮属于已授权普通同步范围');

  // 每轮只读取一次聊天；同批获取配置与增量事件，不要求外层先准备 evidence。
  const reads = await Promise.allSettled([
    invoke(n.read, { message_id: questionId, before: 0, after: 3 }),
    ...writers.map(([id]) => invoke(n.task, { automation_id: id })),
    readRecent()
  ]);
  if (reads.some(x => x.status !== 'fulfilled'))
    return fail('read', '消息、配置或近期记录读取失败；详见 trace');
  const [qr, ...rest] = reads.map(x => x.value);
  for (let i = 0; i < writers.length; i++) {
    const value = rest[i], body = value?.structuredContent;
    const [id, enabled, version] = writers[i];
    if (value?.isError || body?.automation?.id !== id ||
        body.automation.is_enabled !== enabled || body.contextVersion !== version)
      return fail('writers', '已审查任务配置变化或证据字段缺失；需重新核查职责');
  }
  const checkedAt = Date.now();
  const page = rest[writers.length];
  if (!Array.isArray(page.entries) || page.nextCursor || typeof page.resumeCursor !== 'string')
    return fail('recent', '近期增量未完整覆盖；需按真实游标只读补齐，不预占');
  for (const row of page.entries) {
    if (row.source === 'wechat') {
      if (typeof row.eventId !== 'string' || !Number.isFinite(row.receivedAt))
        return fail('recent', '本人事件索引字段不完整');
      eventId = row.eventId;
    }
  }
  if (typeof eventId !== 'string' || !eventId)
    return fail('event', '完整保留记录中未找到本人事件；不得预占');
  result.context = { eventId, conversationCursor: page.resumeCursor };
  const q = qr.message;
  const candidates = Array.isArray(qr.after) ? qr.after.filter(m => m.message_id === answerId) : [];
  const a = candidates.length === 1 ? candidates[0] : null;
  if (qr.partial !== false || qr.room_id !== roomId ||
      !q || !a || q.message_id !== questionId || a.message_id !== answerId ||
      q.author !== 'user' || q.author_id !== ownerAuthorId ||
      a.author !== 'aeon' || a.author_id !== assistantAuthorId ||
      q.deleted_at || a.deleted_at ||
      typeof q.content?.text !== 'string' || !q.content.text ||
      typeof a.content?.text !== 'string' || !a.content.text ||
      !Number.isFinite(Date.parse(q.sent_at)) || !Number.isFinite(Date.parse(a.sent_at)) ||
      Date.parse(a.sent_at) < Date.parse(q.sent_at))
    return fail('source', '房间、作者、正文或发布时间核验失败');
  if ([q,a].some(m => /^微信[·・]/.test(m.content.text) || m.content.library_attachments?.length))
    return fail('source', '微信镜像或含附件来源不走本普通文字入口');
  result.identities = { questionId, answerId, questionPublishedAt: Date.parse(q.sent_at), answerPublishedAt: Date.parse(a.sent_at) };
  let event;
  try { event = await invoke(n.event, { link_id: linkId, eventId }); }
  catch { return fail('read', '本人事件鉴权失败；不得预占'); }
  if (event.eventId !== eventId || event.data?.conversation_id !== 'weixin-self' ||
      event.data?.simulation !== false || !['weixin.owner_text', 'weixin.owner_media'].includes(event.name) ||
      !Number.isFinite(Date.parse(event.timestamp)) ||
      Date.now() - Date.parse(event.timestamp) >= 86_400_000 ||
      Date.parse(event.timestamp) > Date.now())
    return fail('event', '本人事件未通过鉴权或超过期限');

  async function inspect(m, role) {
    const created = Date.parse(m.sent_at), expires = created + 86_400_000;
    if (created > Date.now() || expires <= Date.now()) throw new Error('来源时间无效或过期');
    return { m, role, created, expires };
  }
  const inspected = await Promise.allSettled([inspect(q, 'user'), inspect(a, 'assistant')]);
  if (inspected.some(item => item.status !== 'fulfilled')) return fail('source', '来源窗口无效或已过期；不得预占');
  const [x, y] = inspected.map(item => item.value);

  // 限制本次配置快照存续时间；不是平台期限，也不是并发锁。
  if (Date.now() - checkedAt > 60_000)
    return fail('evidence', '写者证据已过期，需重新核验');

  const claim = async v => {
    const p = await invoke(n.prepare, { link_id: linkId, eventId,
      role: v.role, sourceId: v.m.message_id, sourceText: v.m.content.text,
      sourceCreatedAt: v.created, sourceExpiresAt: v.expires });
    // 服务端合并核验并预占，调用端仍检查完整证据；失败不补发。
    result.preparations ??= {};
    result.preparations[v.role] = p;
    if (p.acquired === true && p.firstSubmissionClaim === true) {
      const h = p.history, o = p.observation?.observedMetadata;
      if (!/^[a-f0-9]{64}$/.test(p.contentDigest || '') ||
          p.observation?.durableReadBack !== true || !o ||
          o.sourceId !== v.m.message_id || o.role !== v.role ||
          o.sourceCreatedAt !== v.created || o.sourceExpiresAt !== v.expires ||
          o.contentDigest !== p.contentDigest || h?.status !== 'not_recorded' ||
          h.coverage?.historyCoverage !== 'complete_for_source_window' ||
          h.directAttemptCoverage?.historyCoverage !== 'complete_for_source_window' ||
          h.directAttemptCoverage.reservationCount !== 0 ||
          h.directAttemptCoverage.status !== 'none_observed' ||
          h.directAttemptCoverage.attributionComplete !== true ||
          h.directAttemptCoverage.hasMore !== false)
        throw new Error('合并核验返回证据缺失；不得发送或重试');
      const m = p.submission;
      if (!m || m.sourceId !== v.m.message_id || m.role !== v.role ||
          m.sourceCreatedAt !== v.created || m.sourceExpiresAt !== v.expires ||
          m.eventId !== eventId || m.contentDigest !== p.contentDigest || m.link_id !== linkId)
        throw new Error('预占绑定元数据不一致；不得发送或重试');
    }
    return p;
  };
  const enqueue = v => invoke(n.enqueue, { link_id: linkId, eventId,
    role: v.role, source: 'chatgpt', sourceId: v.m.message_id,
    text: v.m.content.text, sourceCreatedAt: v.created, sourceExpiresAt: v.expires });
  const record = (v, outcome) => invoke(n.record,
    { link_id: linkId, sourceId: v.m.message_id, outcome });

  let qp;
  try { qp = await claim(x); }
  catch { return fail('prepare-user', '问题预占返回错误或未知；不重试'); }
  if (qp.acquired !== true || qp.firstSubmissionClaim !== true)
    return fail('prepare-user', '未取得首次资格');

  const pair = await Promise.allSettled([enqueue(x), claim(y)]);
  const qe = pair[0], ap = pair[1];
  if (qe.status !== 'fulfilled' || !states.has(qe.value?.state)) {
    result.sources.user = { enqueue: 'error_or_unknown' };
    result.sources.assistant = { prepare: ap.status === 'fulfilled'
      ? { acquired: ap.value?.acquired, firstSubmissionClaim: ap.value?.firstSubmissionClaim }
      : 'error_or_unknown' };
    return fail('enqueue-user', '问题未明确入队；回答不得提交，保留原身份对账');
  }
  result.sources.user = { state: qe.value.state };
  // 立即挂接拒绝处理，避免等待回答入队期间产生未处理拒绝。
  const settle = promise => promise.then(value => ({ status: 'fulfilled', value }),
    () => ({ status: 'rejected' }));
  const writes = [settle(record(x, qe.value.state))];
  if (ap.status === 'fulfilled' && ap.value?.acquired === true &&
      ap.value?.firstSubmissionClaim === true) {
    try {
      const ae = await enqueue(y);
      result.sources.assistant = { state: ae.state ?? 'unknown' };
      if (states.has(ae.state) || ['uncertain','failed','expired'].includes(ae.state))
        writes.push(settle(record(y, ae.state)));
    } catch (err) {
      result.sources.assistant = { enqueue: 'error_or_unknown', error: err };
    }
  } else {
    result.sources.assistant = { prepare: ap.status === 'fulfilled'
      ? 'not_acquired' : 'error_or_unknown' };
  }
  result.recordResults = (await Promise.all(writes)).map(x => x.status);
  return result;
}

```
