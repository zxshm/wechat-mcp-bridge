# WeChat MCP Bridge

一个自托管的、仅限本人微信单聊的 MCP 桥接示例。它把微信文字、图片和普通文件暴露给经过鉴权的 MCP 客户端，并支持把回复发送回同一个已绑定会话。它不包含模型、ChatGPT 或 Dot 的私有实现，也不收集或上传遥测。

> 此代码从实际运行过的单用户桥接实现整理而来；通用配置版需要使用者在自己的环境验收。微信服务和客户端能力可能变化，项目不保证与所有账号或 MCP 客户端兼容。

## 工作方式与限制

1. 用户在自己的终端扫码，随后通过一条新的验证文字绑定微信单聊。桥接器只接受该身份的后续单聊消息，不处理群、其他人、历史相册、语音或视频。
2. 本地服务轮询微信，将文字和媒体事件持久化到加密状态；MCP 客户端通过 `get_wechat_event` 和媒体工具读取。服务可发布 `weixin.owner_text` 和 `weixin.owner_media` webhook 事件，客户端必须具备兼容的事件订阅能力。
3. 回复只能使用已接收事件所绑定的原会话上下文。每条不同回复使用唯一幂等键；结果为 `uncertain` 时不要自动重发或换键，因为上游可能已经收到。`sent` 表示桥接器记录了上游成功响应，不等于已读或用户界面已显示。
4. 单文件上限为 20 MiB，分块上限为 128 KiB。图片仅支持单帧 PNG、JPEG 和 WebP，并验证实际解码；普通文件只作为字节传输，不执行、不解压、不将内容当作指令。事件内容与私有媒体引用最多保留 24 小时；媒体传输缓存为内存，最多 15 分钟且不会超过事件到期时间。

**同步边界：**MCP 工具或 webhook 本身不会自动捕获当前 ChatGPT/Dot 对话的每条消息，也不会自动将图片变成客户端原生附件。要实现同步，客户端必须能读取事件、按需要调用工具并提供附件交付方式；本文不假设客户端提供未公开的消息事件或跨会话上下文接口。断线后可通过 `list_recent_wechat_conversation` 在保留期内分页核对文字与回复状态，但它不是永久历史记录。

## 前提

- Linux 主机、Node.js 24 或更高版本、npm、`flock`、`qrencode`。
- 系统 `/usr/bin/python3` 和 Pillow（Debian/Ubuntu 可安装 `python3-pil`），用于限制资源并验证图片；不满足时图片会安全失败。
- 一个已配置 HTTPS 入口和身份保护的服务。当前实现验证 Cloudflare Access JWT：严格校验签名、公钥、issuer、audience、过期时间和本人邮箱。需要自行配置 Access 应用、仅允许本人访问，并配置指向本地 MCP 服务的受保护入口。
- 客户端须能使用相应受保护入口认证并调用 MCP；可用性、工具刷新与 webhook 支持取决于客户端和账号权限。参阅 [OpenAI 自定义 MCP 文档](https://developers.openai.com/api/docs/guides/custom-mcp-server)及 [Cloudflare Access 文档](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/)。

不要将状态目录、二维码、令牌、Access 配置或真实对话放进 Git。请自行确认使用方式符合微信及相关服务的条款。

## 安装和初始化

1. 获取代码后进入 `wechat-core-offline`，运行 `npm ci`。从仓库根目录执行测试：

   ```sh
   cd wechat-core-offline
   npm ci
   npm test
   ```

2. 创建仅本人可访问的**仓库外**状态目录；从 `.env.example` 创建仅本人可读的配置文件，填写自己的值。`BRIDGE_STATE_DIR` 必须是绝对路径，目录权限为 `0700`。不要把该文件提交或粘贴到对话中。示例（将占位路径替换为自己的路径）：

   ```sh
   mkdir -p "$HOME/.local/state/wechat-mcp"
   chmod 700 "$HOME/.local/state/wechat-mcp"
   mkdir -p "$HOME/.config/wechat-mcp"
   chmod 700 "$HOME/.config/wechat-mcp"
   cp ../.env.example "$HOME/.config/wechat-mcp/bridge.env"
   chmod 600 "$HOME/.config/wechat-mcp/bridge.env"
   # 使用本地编辑器填写 bridge.env，然后在受信任的终端加载：
   set -a
   . "$HOME/.config/wechat-mcp/bridge.env"
   set +a
   ```

   仅加载自己编辑且可信的 shell 格式文件。`BRIDGE_ACCESS_ISSUER` 是 Access 的 HTTPS issuer **origin**，`BRIDGE_ACCESS_AUDIENCE` 是该应用的 audience，`BRIDGE_PUBLIC_HOST` 是对外 MCP 主机名。`BRIDGE_PORT` 默认 `4181`，服务只监听回环地址。可选 SOCKS 主机和端口只用于回调连接；默认直接连接。

3. 首次绑定前确保服务没有运行，在自己的交互终端执行：

   ```sh
   node ../wechat-live-stage/wechat-login-cli.mjs
   ```

   扫码后按提示确认，再向机器人发送终端显示的验证文字。不要分享二维码或状态目录。登录和运行服务使用独占锁，不能同时运行。

4. 启动服务：

   ```sh
   node main-live.mjs
   ```

   将受保护的 HTTPS 入口转发到本机端口的 `/mcp`。在支持的客户端中添加该 MCP 服务并完成认证；根据客户端支持情况分别订阅 `weixin.owner_text` 和 `weixin.owner_media`。不要把公开访问直接转发到未经身份保护的本地端口。后台部署可参考 `examples/wechat-mcp.service`，先自行修改路径并核对身份保护。

## 工具和故障处理

`get_wechat_event` 读取事件元数据；`list_recent_wechat_conversation` 按接收或尝试时间分页。`send_wechat_reply` 需要事件 ID、内容和幂等键。

读取媒体从 `read_wechat_media_chunk` 的 offset 0 开始，保存返回的 SHA-256，后续块携带该值，拼接后再校验摘要。小于等于 4 MiB 的图片也可用 `view_wechat_image` 查看；这不自动创建客户端附件。发送媒体依次调用 `begin_wechat_media_upload`、`append_wechat_media_upload`、`finish_wechat_media_upload`、`send_wechat_media_upload`。

鉴权密钥获取遇到已识别的网络故障、429 或 5xx 时会有限重试；超过预算后返回不可用。服务端鉴权错误可能包含 `pre_execution: true` 和请求关联 ID，表示该请求尚未进入 MCP 工具；客户端不一定会展示这些字段。不能仅凭通用内部错误判断是否已经发送。检查无敏感正文的本地诊断，区分可安全重试的读取和 `uncertain` 发送。启用可选诊断前应自行评估本地元数据保留。

## 开发和许可证

不提交真实消息、账户、图片、域名、令牌或运行状态。仅使用合成数据运行测试。参见 [安全说明](SECURITY.md)和 [第三方声明](THIRD_PARTY_NOTICES.md)。本项目的原创部分按 [MIT 许可证](LICENSE)发布；与微信协议有关的参考资料和依赖保留各自许可证。

## 有界同步队列（0.2.0）

客户端可将一条已验证、需要同步的最终用户消息、助手消息或进度通过 `enqueue_chatgpt_sync_message` 显式入队，并提供稳定的来源消息 ID、角色、全文与已验证的本人微信事件 ID。相同来源 ID 和相同内容重复入队是幂等的；改变内容会被拒绝。内容较长时按顺序分段，最长 24 小时保留正文，去重元数据最长保留 7 天。

`list_chatgpt_sync_queue` 和 `list_wechat_delivery_status` 用于查看队列及入站 webhook 的状态。`queued` 代表尚未发送，`sent` 仅代表上游返回成功并已记录，不保证手机显示；`uncertain` 表示可能发生过发送，不能自动重试或换键重发。顺序队列会在前一项不确定时停住后续项；只有用户明确确认看到了对应分段，才可调用 `confirm_chatgpt_sync_received`。该接口不能表示“没收到”，也不能作为补发授权。确有尚未尝试的排队分段时，`retarget_unattempted_sync` 可在严格条件下将其指向同一本人会话的较新已验证事件。

发送前若发现已有更新的本人上下文，旧上下文的直接回复会返回 `pre_execution: true`；确认没有对同一逻辑消息做过任何发送尝试后，客户端可按提示使用较新事件和同一幂等键。若上游明确拒绝了某上下文，桥接器会暂停对相同上下文的新尝试；新的不同上下文到来后，可继续尚未尝试的队列项。这不改变已尝试项的不确定状态，也不保证上游一定恢复。容量暂不足或上下文无法确定时，新队列项会等待而不是当作已发送；过期后正文仍会被清除。

正常轮询返回消息但未带新游标时，桥接器保留已建立的游标并处理消息，依靠事件 ID 去重。首次绑定的历史边界和本人验证规则不因此放宽。

## 短期上下文诊断

`get_wechat_context_diagnostics` 是只读、仅本人可用的进程内分组统计，不读取额外凭据，也不输出上下文值、消息、事件 ID 或收件人。分组标签是随机值，重启后变化；统计最多保留 24 小时、最多 128 组。文字请求数统计已进入传输的请求，媒体操作数包括上传阶段，未必已发出媒体消息。上游接受不等于手机送达。分组仅能帮助观察未来事件中上下文值是否相同，不能证明微信的配额单位或阈值；客户端若未发现新工具，需按其支持的方式刷新工具列表。

**重要边界：**队列只覆盖客户端明确送入的消息；若客户端没有提供当前对话消息或进度的捕获接口，桥接器无法发现遗漏。网络中断、上游规则和结果不确定均可能阻止即时送达，本项目不保证零遗漏或固定的微信消息额度。

## 发送预算、暂停与恢复

当前版本对同一已验证上下文采用本地 9 次发送预约保护。直接回复、同步的 user/assistant/progress、文字分片及媒体发送共享预算，结果未知的预约也占位；读取、仅入队和上传分块准备不消耗发送预算。文字显示 `(n/9)`，第 9 条带提醒；媒体遇到最后一位时先发送一次文字提醒，媒体本身等待不同的有效本人上下文。

预算用尽后，直接回复返回 `not_sent / waiting_new_owner_context`，不会自动入队。未尝试的同步项保留 `queued` 并按顺序等待；新的有效上下文出现后自动选择最新文字或媒体事件，原幂等身份和到期时间不变。相同 token 的新事件不重置预算。媒体仅在原内存缓存有效期内自动等待，最多 15 分钟，重启不恢复缓存；已发送或结果未知的尝试不能自动重发。

**已知限制：**预算依赖保留记录，跨 24 小时清理后，同一 token 可能再次获得额度；这不是跨保留期的严格累计上限，也不是微信官方配额承诺。

同步工作器每次启动默认暂停，入站轮询和普通直接回复继续工作。先通过 `get_sync_pause_status` 读取当前 epoch 并核对全部队列；仅在用户明确授权且没有待处理项时调用 `resume_empty_chatgpt_sync`，使用当前 epoch 和稳定 operationId。暂停与恢复是进程内控制，不能使用旧 epoch 重放恢复。

`cancel_queued_sync_deliveries` 只取消明确列出的、从未尝试的整批 queued 项的未来投递，任一状态或分片不符则整批拒绝，保留原记录。`cancel_uncertain_sync_delivery` 需要独立的本人明确取消确认；它保留 uncertain 证据，不能证明此前未送达。正式取消成功且持久状态可核对的历史才可通过恢复检查；丢失、未解决或保存结果未知的记录仍阻止恢复。不要直接编辑状态来解除阻塞。

## 入站容量与诊断

文字和媒体合计最多保留 1024 个事件；去重身份最多 4096 个，正文及私有上下文仍在 24 小时内到期，去重元数据最多保留 7 天。加密状态的 JSON 明文硬限为 8 MiB，密文封装固定增加 32 字节；入站、回复与同步入队在 7 MiB 前置保护线处拒绝新增，预留状态更新空间。条数上限不保证容纳 1024 条任意长度消息。

入站批次超限时不部分提交、不推进游标、不锁死存储；正常过期清理释放容量后可以继续接收。新事件或上下文迁移不延长旧消息期限。

`get_mcp_request_diagnostics` 提供只读进程内阶段记录，最多 128 条、最长 24 小时，仅包含随机请求 ID、白名单工具/阶段、耗时和固定错误类别，不含正文、token、认证头或 URL。可选磁盘协议诊断沿用 `BRIDGE_STATE_DIR`，按容量轮换；这部分轮换日志不承诺 24 小时自动删除。隧道的独立受限日志与 HTTP/2 可逆配置见 [隧道诊断说明](docs/tunnel-diagnostics.md)。通用 `-32603` 本身不能确定失败发生在应用、鉴权或隧道哪一层。
