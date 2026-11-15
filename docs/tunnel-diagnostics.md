# 隧道分类日志与可选 HTTP/2 试验

`tunnel-safe-log/` 为 cloudflared 提供有限容量的本地分类日志。监督器在内存读取 stdout/stderr，只保存固定类别及观察时间。它不恢复已经丢弃的日志，也不保证解决所有隧道、鉴权、桥接器或上游故障。HTTP/2 是单独选择的传输试验，不是日志模块的默认设置。

本目录不含生产日志、实际服务配置、自动安装器或凭据。`safe-log.mjs` 与 `runner.mjs` 保持经过运行验证的原始字节；校验值见 [runtime-sha256.json](../tunnel-safe-log/runtime-sha256.json)。通用模板仍需在使用者自己的环境验证。

## 依赖与边界

- Linux、Node.js 24+、用户级 systemd，以及已经配置好的 cloudflared 服务。模块只用 Node 内置库，不需要 npm 安装依赖。
- 示例面向 `Type=exec`、`KillMode=control-group`、`NotifyAccess=none` 的既有服务。保留它的重启策略、停止超时和其他既有约束；不修改全局 journald 或网络权限。
- 监督器仅接受 `cloudflared tunnel run --token-file <绝对路径>` 的参数形状。token 文件由 cloudflared 自己读取；监督器只传递原路径。内联 token、自定义参数形状和 notify 服务不在这些模板的支持范围内。
- 默认控制组信号模式不会再次向 child 转发 SIGTERM/SIGINT：systemd 已向 wrapper 和 child 发信号，再转发可能跳过 cloudflared 的宽限停止。单独向 wrapper PID 发信号不能替代控制组停止。

监督器插入 `--output json --loglevel info --logfile /dev/null --log-directory ""`，不启用 debug，不改变协议或重试参数。cloudflared 2026.10.3 的 [console 配置](https://github.com/cloudflare/cloudflared/blob/2026.10.3/cmd/cloudflared/tunnel/subcommand_context.go#L43-L48)、[独立 console/file 配置](https://github.com/cloudflare/cloudflared/blob/2026.10.3/logger/configuration.go#L64-L92)及 [两个 writer 的创建](https://github.com/cloudflare/cloudflared/blob/2026.10.3/logger/create.go#L82-L96)支持同时输出：`/dev/null` 接收文件副本，JSON console 仍写入 stderr 管道。升级 cloudflared 时应重新核对这一行为和固定消息模板。[官方日志说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/logs/)列出了 JSON 输出方式；debug 可能包含请求细节，不应代替本模块的固定分类。

## 保存哪些信息

记录只有本机观察时间 `at`（epoch 毫秒）、固定 `category`、固定 `state`，以及可选的 `connIndex`（0–255）和 `errorCategory`。不保存原始 message/error、URL、主机名、地址、头、token、连接 UUID、隧道标识、参数或原日志时间。原始流只经过内存管道，不交给 journald，也不保留原始文件副本。模板的 `LimitCORE=0` 禁止此服务产生 core dump。

`errorCategory` 只有九项：`timeout`、`dns`、`certificate`、`authentication`、`connection_reset`、`connection_refused`、`network_unreachable`、`protocol`、`other`。分类器仅匹配长度不超过 4096 字符的固定错误短语；不提取任意状态码或数值。未知、多行、超长或同时匹配不同类别的字符串归 `other`；非字符串不展开。

这些是诊断线索，不是已确认根因。例如：

- `server_error`、`HTTP 500`、`status=503` 和单独的 `403` 均归 `other`，不会把注册 RPC 的通用错误解释为 HTTP 5xx。
- `timeout` 合并了 I/O、deadline、TLS/QUIC 握手及无活动超时；需结合事件类别判断所处阶段。
- `network_unreachable` 不保留地址族或目标，不能独自证明 IPv6、防火墙或整个公网故障。
- `edge_registered` 是某个连接的事件；`collector_started` 只表示 child 的 spawn 成功，二者都不能证明整个 MCP 链路持续健康。

未知 info/warn 和非 JSON 行被丢弃；未知 error/fatal/panic 只记固定类别。日志缺失也可能来自限流、容量满、存储失败或不匹配的模板。写入失败计数只在进程内存，不会输出任意异常字符串；本模块没有诊断 HTTP 端点。

## 容量与实际删除

每路原始流最多保留 16 KiB 未完成行，每秒最多分类 200 行。存储每秒最多接受 20 条，待写最多 64 条／32 KiB，使用一个串行 writer。超额记录被丢弃，不建立无限待写队列。

每个小时桶最多 16 KiB，正常最多 23 桶，总计 368 KiB。桶起点满 23 小时后真实 unlink；桶内记录通常保留 22–23 小时。启动、每分钟空闲清理、新小时写入前清理，以及独立的 systemd timer 共同执行删除。timer 不依赖 tunnel 进程存活。

日志目录应放在仓库外，权限 `0700`，文件为 `0600`。清理器只处理专用目录内严格命名的普通单链接文件；遇到符号链接、硬链接、外来文件或不安全权限时拒绝操作。不把日志纳入备份、同步或 Git。

主机断电、用户 manager 停止、时钟跳变、调度停顿或文件系统故障时，不能保证到点物理删除；恢复运行后先清理。运行期间的 24 小时目标依赖清理任务持续成功。本模块不自动启用 linger 或提高权限。

## 准备与安装

以下是需要使用者实际审阅后执行的步骤；仓库不会自动安装服务。

1. 在自己的主机确认既有服务的可执行文件、参数形状、服务类型和 KillMode。只在本地私有目录备份原 unit/drop-in 并记录哈希，不备份 token 文件或打印完整环境。确认没有其他 drop-in 改写相同设置。
2. 将两个 runtime 文件安装到仓库外、由服务用户拥有且其他用户不可写的代码目录。为日志选择一个独立目录，先创建并设置 `0700`；不要将桥接器状态目录直接当作日志目录。
3. 从下面模板创建私有 staging 副本。将所有 `@...@` 替换为核实过的绝对路径；`@EXISTING_TOKEN_FILE@` 只使用现有路径引用，不复制 token 内容。路径应按 systemd 引号规则处理；这些值不是 shell 命令。

| 模板 | 安装位置或名称 |
|---|---|
| [tunnel-safe-log.conf.example](../examples/tunnel-safe-log.conf.example) | 既有 tunnel 用户服务的 `.service.d/30-safe-log.conf` |
| [tunnel-safe-clean.service.example](../examples/tunnel-safe-clean.service.example) | 用户 unit 目录中的 `tunnel-safe-clean.service` |
| [tunnel-safe-clean.timer.example](../examples/tunnel-safe-clean.timer.example) | 用户 unit 目录中的 `tunnel-safe-clean.timer` |

`@NODE_EXECUTABLE@` 是 Node 的绝对路径；`@RUNNER_PATH@` 指向安装的 `runner.mjs`；`@LOG_DIRECTORY@` 指向独立日志目录；`@CLOUDFLARED_EXECUTABLE@` 和 token-file 路径保留原配置。标准用户 unit 目录为 `~/.config/systemd/user/`。模板不替换原基础 unit；如果已存在同名清理 unit，先确定名称不会冲突，并一致更新 timer 的 `Unit=`。

4. 在隔离目录先运行测试和 `systemd-analyze --user verify` 检查最终 unit/drop-in/service/timer。确认没有未替换占位符，`StandardOutput=null`、`StandardError=null` 和 `LimitCORE=0` 生效。测试和 syntax verify 不会安装或启动服务。
5. 安装经过核对的副本，执行用户级 daemon-reload，先启用清理 timer 并核对它的下一次执行及清理结果，再重启既有 tunnel 一次。此次重启可能短暂中断外部连接；不需要为日志模块重启 MCP 或修改任何消息队列。
6. 用分类事件、cloudflared 自身可用的本机 readiness/连接信息及已授权 MCP 只读操作共同检查。仅 systemd active 或桥接器本机健康 200 不足以证明外部链路恢复。检查文件权限、总大小和清理任务确实成功。

## 可选 HTTP/2 试验及回滚

[tunnel-http2.conf.example](../examples/tunnel-http2.conf.example)仅设置 `TUNNEL_TRANSPORT_PROTOCOL=http2`。它单独安装为既有 tunnel 服务的一个 drop-in，与日志 wrapper 分开管理；wrapper 会继承环境。确认没有更高优先级的协议设置后，记录原配置，再在允许中断的窗口 reload 并重启 tunnel 一次。默认不改变协议，也不声称 HTTP/2 能修复所有故障。

观察预先选定的窗口，记录每个样本的 readiness、连接数、重连和错误类别，并核对正常的已授权只读业务请求。把它表述为采样观察；经历过异常后不能仅因计时器到点就声称连续健康。实际子进程的协议环境与 TCP 连接提供支持证据，TCP 数量本身不是每条连接的 HTTP/2 协商证明。无需启用 debug 或读取凭据来做这些检查。

如果只撤回 HTTP/2 试验，删除仅本次新增的协议 drop-in，再 reload/restart，恢复此前协议选择；日志可以继续保留。如果撤回整个 wrapper，移除仅本次日志 drop-in，恢复原 ExecStart，reload/restart 后核对原服务。回滚会产生另一次 tunnel 重启。保留清理 timer、清理 service 和 runtime 文件，直到所有分类日志已经实际删除，再停用并移除本次新增的清理组件。回滚命令完成不代表业务已恢复，仍需核对 readiness 和只读链路。

## 禁网测试

在仓库根目录运行：

```sh
node tunnel-safe-log/run-tests.mjs
```

入口清除测试子进程的 `NODE_OPTIONS`、`NODE_PATH` 并强制载入禁网 preload。测试只使用合成 JSON、临时文件和假 child，不启动 cloudflared，不读 token 文件、不连接外网。Linux 专项用真正的模拟进程组检查单次 SIGTERM、ENOENT、权限和链接拒绝；`systemd-analyze --user verify` 只对临时合成配置做离线语法检查，不调用 systemctl。Linux 专项在其他平台跳过。

测试覆盖固定类别及秘密不落盘、字节/速率/队列上限、启动/空闲/重启后的实际删除、spawn 失败及信号行为。Node 导入这些 runtime 文件不会启动网络；仅显式运行 `runner.mjs run ...` 才会启动指定 child。
