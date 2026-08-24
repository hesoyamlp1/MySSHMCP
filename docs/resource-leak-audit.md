# 资源泄漏核查表（2026-08-23）

## 为什么有这份

2026-08-23 搬瓦工（1G 内存）ssh 登不进：ping 通、10328 端口 TCP 能建立、但 banner 交换超时，v2ray 也被 OOM 反复杀。
机器上 746 个 sshd-session，368 条连接来自 VPS，按年龄每小时整整 6 条、堆了 61 小时。
根因在 ssh-hub：会话回收时只关了 vps 节点 in-process 的 McpServer，没关它的 SSHManager，
最后连的那台机器的 ssh 连接一直留到 daemon 退出；集群采样器每 10 分钟经 vps 节点连一次搬瓦工，每轮留一条。

这一处修在 35d6bb1。用户要求把同类问题查全：**每种挂在会话上的资源，对着会话的三条退出路径各查一遍。**

三条退出路径：
- **A** 客户端发 DELETE /mcp（SDK 处理 → `transport.close()` → `transport.onclose` → 该会话的 `close()`）
- **B** idle reap（index.ts 的 sweepTimer 每 5 分钟扫，超过阈值调 `transport.close()`，之后同 A）。阈值：直连 daemon 和 ssh-hub 30 分钟（ssh-hub 原来 24 小时，2026-08-23 改），browser-hub 2 小时
- **C** 客户端非优雅断开（Claude 进程被杀、隧道断）。StreamableHTTP 是逐请求的，服务端察觉不到，只能等 B

hub 模式里 vps 节点是 in-process 直连 server（一份 SSHManager），其它节点是经 HTTP 连远程 daemon 的 MCP client；
远程 daemon 上每个 hub 会话又对应一份它自己的会话 + SSHManager。

## 核查表

结论列：**漏** = 查到并已修；**漏（未修）** = 查到但这次没改，原因写在最后一节；**不漏** = 查过没问题。

### 会话层（index.ts / hub.ts / hub-client.ts / server-factory.ts）

| 资源 | 退出路径 | 结论 | 说明 |
|---|---|---|---|
| vps 节点 in-process 的 SSHManager | A / B | 漏（35d6bb1 已修） | `closeExtra` 只 `server.close()`，SSHManager 不断。现在先 `sshManager.disconnect()` 再关 server |
| hub → 远程 node 的 Client + StreamableHTTPClientTransport | A / B / C | 漏 | SDK 的 `Client.close()` 只 abort 本地 SSE、**不发 DELETE**，mac 那边的会话和它的 SSHManager 要等 30 分钟 idle 回收。现在 `closeConn()` 先 `transport.terminateSession()`（3 秒上限）再 `close()`；握手超时的半连接同样走这条路 |
| 同上，会话关闭时有调用在飞 | A / B | 漏 | `closeAll` 把连接关掉，在飞的 `callTool` 以 "Connection closed" 失败 → `isConnectionError` 命中 → `drop` + `getConn` 重新建连并重发。重建出来的连接（vps 节点就是一份新 SSHManager）在 `closeAll` 之后没人回收。现在 `closed` 标志置位后 `open()` 拒绝建连、`callTool` 不重连 |
| 同上，并发两次首次使用同一 node | 任何 | 漏 | `getConn` 没有在飞去重：两次都进 `open()`，后建的 `conns.set` 覆盖先建的，先建那条没人关。现在按 node 名存在飞 Promise |
| `drop` 不等关闭完成 | 进程退出 | 漏 | `drop` 是 fire-and-forget，`closeAll` 返回时 DELETE 还没发出去。现在 `drop` 返回 Promise，`closeAll` 用 `Promise.allSettled` 等 |
| serveHttp 的 SIGTERM cleanup | 进程退出 | 漏 | 原顺序先 `await httpServer.close(cb)`：Node 的 `server.close()` 要等所有连接断开才回调，挂着 SSE 长连接的会话永远不断，15 秒后被 systemd SIGKILL，会话清理一行都跑不到。现在先关会话（发 DELETE、断 ssh），再 `httpServer.close()` + `closeAllConnections()`。实测带一条 SSE 长连接时 0.2 秒退出 |
| stdio 形态（直连 / hub / browser-hub 三处）的 SSHManager 和下游连接 | 父进程被 SIGKILL | 漏 | 只挂了 SIGINT/SIGTERM；SDK 的 StdioServerTransport 只监听 stdin 的 data/error，stdin 到 EOF 时 `transport.onclose` 不触发，ssh2 的 keepalive 定时器把进程一直撑着。现在 stdin 的 end/close 也触发 cleanup。实测：老代码 stdin 关掉后 20 秒不退（超时杀掉），新代码立刻退出 |
| initialize 没成功的会话 | 任何 | 漏 | 每个 initialize 请求都先 `makeServer()`；browser-hub 的 BrowserClientManager 构造时就起了 setInterval，`onsessioninitialized` 没触发它就不进 `sessions`，永远没人 `close()`。现在 `handleRequest` 之后没拿到 sessionId 就调 `close()` |
| `sessions` Map、sweepTimer、withTimeout 的定时器 | 全部 | 不漏 | `sessions.delete` 在 onclose；定时器都 unref + clear |
| `hubList` 对每个在线 node 各开一条下游连接 | — | 漏（未修） | `ssh({action:"list"})` 的子列表经 `mgr.callTool(node, "ssh", {action:"list"})`，一次 list 在每台 mac 上各留一个会话，直到本会话结束（现在结束时会发 DELETE，所以有界） |
| hub 的 idle 阈值 | C | 漏（已改） | 原来 24 小时，非优雅断开的 Claude 会话要 24 小时后才开始回收链。验过 Claude Code 拿 404 会自动重新 initialize 后，2026-08-23 改成 30 分钟（8a8c52e，决定 d3），2.9.6 已在全集群生效 |

### SSH 连接层（ssh-manager.ts / shell-manager.ts / sftp-manager.ts / exec-runner.ts）

| 资源 | 场景 | 结论 | 说明 |
|---|---|---|---|
| exec 通道 | 命令超时 | 漏 | 超时只 `signal("KILL")`（sshd 不实现）+ `stream.end()`（只发 EOF，通道 allowHalfOpen 不关），Promise 等 close 事件才落地——远端进程不退它就不来；hub 层在 timeout+30s 把请求砍掉，模型看到的是请求超时而不是 `timedOut` 的结果。现在超时时 `stream.close()`（发 CHANNEL_CLOSE）、卸掉 data 监听、立刻按已收到的输出 resolve。实测 timeout 3 秒的 `sleep 30` 5 秒返回超时文案（原来 33 秒以上） |
| PTY shell 通道 | reset_shell / hardReset | 漏 | 旧 shell 只 `end()`（EOF）：前台程序不读 stdin（sleep / tail -f / 卡住的构建）时远端进程和通道都活着；data 监听没有身份守卫，旧通道输出继续写进新缓冲。现在用 `close()`（sshd 给会话 SIGHUP），data 监听加 `this.shell !== stream` 守卫。实测 pty 里 `sleep 123` 超时后 reset_shell，远端进程 1 → 0 |
| PTY 输出缓冲 | 长输出 / 无换行输出 | 漏 | 只限 10000 行，单行和没换行的尾巴无上限（进度条类 `\r` 刷新的输出全堆在尾巴里），每次 data 都整段 split。现在尾巴留 64K 字符、总量 8M 字符从头丢、按最后一个换行切一次 |
| PTY shell / sftp 通道 | 并发两次首次打开 | 漏 | 第二条覆盖 `this.shell` / `this.sftp`，第一条没人关；sftp 的 close 回调会把活的那条误清空。现在 open / getSftp 用在飞 Promise 去重，close 回调加身份守卫 |
| ssh2 Client 的 error 回调 | 换 server 后旧连接晚到的 error | 漏（误关） | 三处 error 回调都无条件 `cleanup()`，会把正在用的新连接一起关掉。现在只有还是当前连接才 cleanup，否则只 end 自己 |
| ProxyJump 的 jumpClient + forwardOut 通道 | 第二跳凭据读不到 | 漏 | 跳板已 ready、forwardOut 已开，直接 reject 不关；`isConnected` 为假，之后没有任何路径会来关它。现在 reject 前 end 跳板、清引用；forwardOut 失败也清 `this.jumpClient` |
| SOCKS 代理 socket | 代理通了、凭据读不到 | 漏 | 同上，reject 前不 destroy。现在一并销毁，`this.client` 也不留没连的对象 |
| execLocal 子进程 | stdin 喂不完（命令提前退出） | 漏（会崩） | `child.stdin.end(stdin)` 没有 error 监听，EPIPE 是未捕获异常，会把 daemon 打崩。现在挂了空 error 监听 |
| execLocal 子进程 | 超时 | 漏 | SIGKILL 只杀 `bash -c` 那个 shell，子孙进程握着管道时 close 不来、Promise 挂着。现在 SIGKILL 后 1 秒销毁管道、按超时落地。没改成 detached 进程组：那会让 exec 起的后台进程在 daemon 重启后活下来，跟现有"只有 tmux 起的活得下来"的约定冲突 |
| ssh2 Client / jumpClient / sftp / shell | disconnect、cleanup、换 server、握手失败、连接中途断 | 不漏 | disconnect 先 end 再 cleanup；换 server 先 `disconnect()` 再建；ssh2 自己 destroy socket；通道随 socket 关 |
| sentinel 等待的 setInterval、open 的 500ms 定时器、net-probe 的 socket | 全部 | 不漏 | 都 clear / destroy |
| output-store 磁盘文件 | 会话回收 | 不漏 | 按 mtime 只留 50 个，内容来自已封顶的 stdout |
| sentinel 等待期间 shell 被关 | — | 漏（未修） | `waitForCompletion` 不感知 `this.shell` 变 null，要等到 maxTimeout（≤300 秒）才 resolve。只是多等，不占资源 |
| 对端已死时 `client.end()` | — | 看不出来 | 只发 FIN，对端不回则 fd 留到内核重传超时（分钟级），有界 |

### browser-hub（browser-hub.ts / browser-client.ts）

| 资源 | 场景 | 结论 | 说明 |
|---|---|---|---|
| 到 mac 上游的 Client + transport | A / B 正常关闭 | 不漏 | `drop` 本来就先 `terminateSession` 再 `close` |
| 同上 | C | 不漏（延迟） | 2 小时后走 B；期间 30 分钟没调用就 `sweepIdle` drop |
| 同上，会话关闭时有 browser_* 调用在飞 | A / B | 漏 | `closeAll` → 在飞请求以 "Connection closed" 失败 → `recoverAndRetry` → `open()` 重新建上游连接。此时 idleTimer 已清、会话已删，这条连接没人 drop；上游 ping 由 SDK 自动应答，心跳判不死它——有头 mac 上就是一个关不掉的窗口。现在 `closed` 标志置位后不建连、不自愈 |
| 同上，`useNode` 在 up 命令或轮询期间会话被关 | A / B | 漏 | 轮询完回到 `listTools` → `getConn` → `open()`，同上。同一个 `closed` 标志覆盖 |
| 同上，并发首次使用同一台机器 | 任何 | 漏 | `getConn` 无在飞去重，先建的上游 session 被覆盖后永久存在。现在按机器名存在飞 Promise |
| hub-client 里 up/down/refreshState 用的 ssh 连接 | 会话关闭时命令在飞 | 漏 | 同会话层"在飞重连"那条，走 vps 节点时会新建一份 SSHManager 并 ssh 到 windows-4070ti。同一个修法 |
| `drop` fire-and-forget | 进程 SIGTERM | 漏 | DELETE 还没发出去就 exit，上游 context 只能靠 playwright-mcp 心跳收（0.0.75 收不掉）。现在 `drop` 返回 Promise、`closeAll` 等它 |
| `idleTimer` | A / B / C | 不漏 | closeAll 第一行 clearInterval，且 unref |
| 工具清单缓存、快照/截图结果、按 node 名存的 Map | 任何 | 不漏 | 随会话闭包释放；结果不存；Map 大小 ≤ 机器数 |
| 转发中挂着的请求 | 上游不回 | 不漏 | connect 8s、callTool 120s 或 time+60s、listTools 15s、terminate 3s 都有上限 |
| `browser_wait_for` 超过 30 分钟 | 上游 idle 判死 | 漏（未修） | `lastUse` 只在调用开始时刷，等待中途被 `sweepIdle` drop（不漏资源，但调用会报"没执行"） |

## 2.9.6 rollout 与升级后的残留检查（2026-08-23）

npm 2.9.6 发布后按 skill deploy-ssh-mcp 的顺序升级：三台 mac `npm i -g`（公司两台走 npmmirror）+ `launchctl kickstart -k`，
windows `npm i -g` + WMI 脱离会话跑 `~/.mori/hub-restart.ps1`（杀 27777 的监听进程再跑 hub-up.ps1），
最后 VPS `npm i -g` + `systemctl restart ssh-hub browser-hub`，`claude --version` 仍正常。
`ssh({action:"list"})` 现在直接报每个 node 的版本和会话数，五个 node 全部 2.9.6。

升级后逐台看过残留，结论：
- 三台 mac 的 daemon 攥着的都是回环的会话连接（air 12 / mini-1 4 / mini-2 2），升级前也没有异常堆积；
  隧道以外没有游离的 ssh 客户端进程。mini-1 / air 上的几十个 chromium 进程是用户自己的 Chrome（随登录起的）
  加 playwright daemon 的那一个实例，不是泄漏。
- windows daemon 会话数 20 是升级过程中失败调用堆的，重启即清。
- 野草云、搬瓦工：sshd 会话进程各 0 / 12（搬瓦工那 12 个是 windows 隧道 + v2ray + 野草云的正常连接）。
- VPS：升级时还有两个别的会话私有的 stdio 形态 `mcp-ssh-pty` 进程锁在 2.9.5，要等那两个会话自己重开；
  hub 进程对外只有到各 mac 隧道的回环连接，到搬瓦工 0 条。

## 这次改了什么（都在 2.9.6 里）

- 35d6bb1 vps 节点回收时断 SSHManager（事故那处）
- hub-client.ts / browser-client.ts：`closed` 标志、在飞去重、`closeConn` 先 DELETE 再 close、`drop` 返回 Promise
- index.ts：SIGTERM 先关会话再关 HTTP、stdio 形态监听 stdin 结束、initialize 失败回收
- exec-runner.ts：远程 exec 超时立即落地并关通道；execLocal 超时后销毁管道；stdin 挂 error 监听
- shell-manager.ts：reset 用 `close()`、data 监听身份守卫、缓冲字节上限、open 去重
- sftp-manager.ts：getSftp 去重 + close 回调守卫
- ssh-manager.ts：error 回调身份守卫；凭据读不到时销毁代理 socket / 跳板连接

## 怎么验的

起两个临时实例（都用 `.wt/T14/dist`，不碰在跑的服务）：直连 daemon 在 27796 冒充一台 mac，hub 在 27795 用临时 hub.json 指向它和 vps 节点。脚本在会话的 scratchpad `t14test.py`，要重跑照着起。

| 验证 | 结果 |
|---|---|
| hub 会话 DELETE 后，下游 daemon 的 `/health activeSessions` | 1 → 0（老代码要等 30 分钟） |
| 会话里起 `sleep 20`，2 秒后 DELETE，看 hub 进程到野草云的 ssh 连接 | 0 条；在飞调用报错不重发 |
| `ssh({command:"sleep 30", timeout:3})` | 5.1 秒返回超时文案（老代码 33 秒以上才由 hub 层砍掉） |
| pty 里 `sleep 123` 超时后 `reset_shell`，远端 `ps` 数 `^sleep 123$` | 1 → 0 |
| 挂一条 SSE GET 长连接后给 hub 发 SIGTERM | 0.2 秒退出（老代码卡到 systemd 15 秒 SIGKILL） |
| stdio 形态喂 initialize + connect 野草云后关 stdin | 新代码立刻退出；老代码 20 秒不退 |
| POST 一个没有 params 的 initialize | 日志出现 `initialize failed, discarding half-built session` |

## 遗留四处的处理（用户 2026-08-23 定）

- **hub 24 小时 idle 阈值**：先验证了 Claude Code 对 404 的反应（见下一节），用户定降到 **30 分钟**，跟直连 daemon 一致（index.ts 的 `defaultIdleMs`，随 2.9.6 生效）。
- **`hubList` 在每台 mac 上留会话**：不改。有界（随本会话结束发 DELETE），只是 mac daemon 的 activeSessions 数字偏高。
- **sentinel 等待不感知 shell 关闭**：已修（5514cff）。等待循环记住等的是哪条 shell，它被关掉就立刻返回并说明。实测 pty 里 `sleep 100`（timeout 90）在 reset_shell 后 3.0 秒返回。
- **`browser_wait_for` 超过 30 分钟被 idle 判死**：已修（5514cff）。按机器计数在飞请求，`sweepIdle` 跳过有请求在飞的连接；请求结束再刷一次 `lastUse`。
- **execLocal 不改 detached 进程组**：见上表，维持。

## Claude Code 对会话被回收（404）的反应

验证方法：用全局装的 2.9.5 起临时 hub `--idle-min 1`（端口 27797），写一份只含它的 mcp-config，
`claude -p --model haiku --strict-mcp-config` 跑一段固定步骤：调 `ssh list` → Bash `sleep 330` → 再调 `ssh list`。

结果：hub 日志 `reaping idle session … (idle 285s)` → `session closed` → 紧接着 `session opened`（新 id）；
Claude 的报告 STEP3 是 SUCCESS，跟 STEP1 返回一样，没有任何错误经过模型。
对照 Claude Code 客户端代码：POST 拿到 404 走 `session_expired_404`，「clearing connection cache for re-initialization」，
只有 SSE GET 流的 404 不触发重新初始化（`get_stream_404_not_reinit`）。

所以降 hub 的 idle 阈值对使用者是透明的。真正的代价只有一个：被回收的会话里的状态没了——当前 node、连着的 server、
PTY shell 的 cwd 和环境。回收之后第一次 `ssh({command})` 会收到「未连接服务器，请先 connect」，模型照提示重连一次即可。

## 排查时的判据

- 目标机上 `pgrep -c sshd-session` 上百、且 VPS 侧 `ss -tnp state established '( dport = :<port> )'` 按 pid 分组集中在 hub 进程，就是本文这类漏。
- **不重启 hub 也能清现场**：对 hub 进程每条泄漏 socket 的源端口逐条 `ss -K dst <ip> sport = :<port>`，内核直接销毁，ssh2 client 收到 close 自己 cleanup，对端 sshd-session 立刻退出。重启 hub 会掐断所有会话的连接，能不重启就不重启。
