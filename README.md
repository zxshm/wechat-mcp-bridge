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
