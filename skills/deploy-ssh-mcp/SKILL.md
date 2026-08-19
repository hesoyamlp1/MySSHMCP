---
name: deploy-ssh-mcp
description: "部署、扩展、排查这套多机 hub：VPS 上两个常驻服务(ssh-hub 27790 / browser-hub 27791，都是 mcp-ssh-pty，读同一份 ~/.mori/ssh/hub.json)分发到各台机器。触发：'加一台机器到 ssh-hub / browser-hub'、'node online false / 连不上 / list 显示离线'、'反向隧道端口冲突 / EADDRINUSE 27777'、'daemon 起不来 / connect local 坏了'、'换机 / 迁移 / 注册 hub'、'发新版 / npm publish / rollout 升级'、'某台跑的版本不对 / 改了配置没生效'。只是给某台机器加快捷命令用 ssh-hub-shortcuts；隧道抖动和链路健康用 ssh-hub-link-health。"
---

# 部署 ssh-hub / browser-hub

本文件写**怎么装、怎么加机器、怎么发版、坏了怎么查**。日常用法在工具描述里，不在这。
隧道反复抖动、错误率、ProxyJump 那类**运行时链路健康**问题看 skill `ssh-hub-link-health`。

---

## 一、当前架构（2026-08-17）

VPS 上跑两个 systemd 常驻服务，都是同一个包 `@mori-mori/mcp-ssh-pty` 的不同模式，读同一份
`~/.mori/ssh/hub.json`：

```
Claude Code / codex (VPS)          MCP 地址固定，不用 /mcp 重连
  ├─ ssh-hub      http://127.0.0.1:27790/mcp   (systemd ssh-hub.service,     --hub --http)
  │    ├─ vps              in-process ─────── VPS 本机 shell
  │    │     └─ 它下面还挂着三台没有自己 daemon 的机器（ssh-servers.json）：
  │    │        windows-4070ti(经 2201 反向隧道) / 野草云美国 / 搬瓦工
  │    ├─ macbook-air      http://127.0.0.1:27778/mcp   公司·主力
  │    ├─ mac-mini-1       http://127.0.0.1:27779/mcp   公司·备用
  │    ├─ mac-mini-2       http://127.0.0.1:27780/mcp   家里
  │    └─ windows-4070ti   占位 url（见第五节，它没有 ssh daemon，list 里永远离线是正常的）
  │
  └─ browser-hub  http://127.0.0.1:27791/mcp   (systemd browser-hub.service, --browser-hub --http)
       ├─ macbook-air      http://127.0.0.1:27781/mcp → 该机 loopback 8930 → chromium
       ├─ mac-mini-2       http://127.0.0.1:27783/mcp
       ├─ windows-4070ti   http://127.0.0.1:27784/mcp
       └─ mac-mini-1       27782 预留，还没铺
```

**两层寻址**：`node` 选哪台机器，`server` 选该机器内部哪台（`local` = 那台本机 / 它能直连的内网机）。

**为什么这么分**：一条 MCP 注册管全部；每台机器仍是自己的 daemon 干活 → 一跳 sftp、本地直连、
各自的 notes/shortcuts；多台的 PTY 可同时活着；`list` 逐 node 探活显示 online。

---

## 二、端口纪律（弄错了就只能连一台）

VPS 上一个端口只能被一条反向隧道绑定。每台机器的 **ssh daemon 本地统一听 27777**、
**playwright 本地统一听 8930**（不用每台改），错开的是**反向隧道暴露到 VPS 的端口**：

| 机器 | ssh daemon → VPS | browser → VPS | 备注 |
|---|---|---|---|
| macbook-air | 27778 | 27781 | 公司主力；另提供公司 git 9022 |
| mac-mini-1 | 27779 | 27782（预留未铺） | 公司备用；git 隧道已停 |
| mac-mini-2 | 27780 | 27783 | 家里 |
| windows-4070ti | 无（经 vps 节点的 2201） | 27784 | 只有浏览器，没有 ssh daemon |
| — | **27777 永久留空** | — | 历史上是 ssh-mac 单活入口，已退役 |
| VPS 自己 | 27790 = ssh-hub | 27791 = browser-hub | 只绑回环 |

加新机器：ssh 端口从 27785 往后取，browser 端口同理，别碰上面这些。
两台写同一个 VPS 端口 → 第二台静默失败（`remote port forwarding failed for listen port …`），
表现就是「两台只有一台能用」。

**共享端口 9022 = 公司内网 git**：VPS `9022 → 公司 GitLab 10.176.201.75:22`，VPS 的
`company-git` 别名指向 `localhost:9022`。⚠️ GitLab 正确 IP 是 **10.176.201.75**，不是
10.12.3.198（后者 `nc` 通但 SSH 立刻 `Connection closed`，2026-06-22 排查过半天）。
air 和 mini-1 都能提供，**当前主 = macbook-air**，mini-1 的 git-tunnel 已停（避免双机抢占）。
家里的 mini-2 够不到公司内网，不配这条。
⚠️ 提供 9022 的机器，`vircs` 块里**必须去掉 `ExitOnForwardFailure yes`**——否则第二台连接时
9022 撞车会拦死整条 SSH（症状：开第二台 mac 时它整个连不上 VPS）。

---

## 三、版本与 rollout（最容易出错的一节）

**三层版本是独立的，`/health` 报的是「进程启动时加载的代码」，不是磁盘上的包版本**：

```bash
npm view @mori-mori/mcp-ssh-pty version                      # npm 上最新
grep '"version"' /usr/lib/node_modules/@mori-mori/mcp-ssh-pty/package.json   # 本机装的
for p in 27790 27791 27778 27779 27780; do curl -s http://127.0.0.1:$p/health; echo; done  # 各进程真在跑的
```

2026-08-17 当天就出现过三层全不一样：npm 2.9.0 / 全局包 2.9.0 / ssh-hub 进程 2.8.0。
**stdio 模式的 MCP 进程更顽固**：它锁死在会话启动那一刻的代码，覆盖全局包对它完全无效，
只能重开那个会话。判断某个会话跑的是新是旧，看它的 MCP 进程启动时间和全局包落盘时间谁先谁后：

```bash
stat -c '%y' /usr/lib/node_modules/@mori-mori/mcp-ssh-pty/dist/index.js   # 包落盘时间
ps -eo pid,ppid,lstart,args | grep mcp-ssh-pty | grep -v grep             # 各进程启动时间
```

### 发版链路（跨机只走 git，绝不传文件）

**npm 发布只能在 macbook-air 上做，而且要 2FA 一次性密码**（2026-08-17 实测：VPS 上根本没有
`~/.npmrc`；mac-mini-1 和 mac-mini-2 有但 token 已失效，`npm whoami` 报 401；只有 air 有效）。

```bash
# 1. VPS：改源码 → bump package.json → commit → push
npm version <x.y.z> --no-git-tag-version && npm run build   # build 只为本地验证，dist 是 gitignore 的
git add src docs package.json package-lock.json && git commit -m "..." && git push origin HEAD:main

# 2. air：拉代码 + 发布（注意大小写：air 是 ~/Passion，mini-2 是 ~/passion）
ssh({node:"macbook-air", server:"local", command:"cd ~/Passion/MySSHMCP && git fetch origin && git merge --ff-only origin/main"})
ssh({node:"macbook-air", server:"local", command:"cd ~/Passion/MySSHMCP && npm publish --otp=<6位码>"})
#    不带 --otp 会报 EOTP。码 30 秒过期，拿到就立刻跑。prepublishOnly 会自动 build。

# 3. rollout：每台升包 + 重启进程（升包不重启进程等于没升）
npm i -g @mori-mori/mcp-ssh-pty@latest
launchctl kickstart -k gui/$(id -u)/com.mori.mcp-ssh-pty-http    # 各 mac
systemctl restart ssh-hub browser-hub                            # VPS
```

⚠️ **VPS 上禁止 `npm install -g .` / `npm link` 覆盖全局包**——全局 bin 必须是 npm 发布版。
改完源码要生效就走上面的发布链路，没有捷径。

⚠️ **重启 ssh-hub 会让所有会话的旧 session 失效**（服务端回 404）。但 2026-08-17 实测：
Claude Code 会自己重新 initialize，**多数情况不用手动 `/mcp`**，下一次工具调用就正常了，报错了再敲。
所以重启的代价比早期文档写的小，不必特意挑时机；有会话正在跑长任务时说一声即可（长任务在
mac 上的 tmux 里，不受 MCP 层重启影响）。重启顺带把积压的僵尸 session 全部清空。

⚠️ **`kickstart -k` 会杀掉 daemon 进程组里的所有后台进程**。经 exec 通道用 `nohup` 起的后台任务，
即使被 launchd 收养（`ppid=1`），进程组仍是 daemon 那个，照样被带走——判据看 PGID/SESS 不是 PPID。
所以**升级任何一台的 daemon 前，先确认那台没有别的会话留的后台长任务**（2026-08-17 一次 rollout
误杀过别的会话的探测进程）。长任务本来就该用 tmux 起，见下。

### 长任务一律 tmux

```bash
mkdir -p ~/.mori/jobs && tmux new -d -s job-<名> '<命令> > ~/.mori/jobs/<名>.log 2>&1; echo rc=$? > ~/.mori/jobs/<名>.status'
```

`cat ~/.mori/jobs/<名>.status` 判断完没完（文件不存在 = 还在跑）。**别用 nohup / disown / 结尾 &**，
理由同上。`timeout` 上限 300 秒，而且超时只是我们不再等——远端进程还在跑（OpenSSH 的 sshd 不实现
signal 请求，杀不掉），所以超过 5 分钟的活不要靠调大 timeout。

---

## 四、配置生效方式（常驻化的代价）

| 配置 | 谁读 | 改完怎么生效 |
|---|---|---|
| `~/.mori/ssh/hub.json`（节点、token、note、browser 段、browserRoutes） | 两个 hub 服务**启动时读一次**，整进程缓存 | `systemctl restart ssh-hub` / `browser-hub`。旧 session 失效，但客户端多数会自动重连（见第三节） |
| `~/.mori/ssh/ssh-servers.json`（某台机器内部的 server 列表 / shortcuts） | **每个 MCP 会话各读一次** | 新开会话即生效，老会话 `/mcp` 重连即可，不用重启服务 |
| 各机 `~/.mori/ssh/notes/<server>.md` | 按需读（`action:"notes"`） | 立即生效 |

hub.json 含 token，`chmod 600`。远程节点的 token 必须与那台机器 daemon 的 `MCP_HTTP_TOKEN`
一致（多台可以共用同一个）。

### VPS 侧注册（一次性，已完成）

```bash
source /root/.mori/ssh/hub-http.env
claude mcp add -s user --transport http ssh-hub     http://127.0.0.1:27790/mcp --header "Authorization: Bearer $MCP_HTTP_TOKEN"
claude mcp add -s user --transport http browser-hub http://127.0.0.1:27791/mcp --header "Authorization: Bearer $MCP_HTTP_TOKEN"
```

codex 侧写在 `~/.codex/config.toml`，**注意它不认 `bearer_token` 字段**（报
`bearer_token is not supported for streamable_http`），要用 `http_headers`：

```toml
[mcp_servers.ssh-hub]
url = "http://127.0.0.1:27790/mcp"
http_headers = { Authorization = "Bearer <token>" }
```

改完用 `codex mcp get ssh-hub` 验证（能解析且显示 `Auth: Bearer token` 就对）。
codex 的 MCP 进程跟着它的会话生命周期，改配置对**正在跑的会话不生效**，要新开。

---

## 五、加一台机器

### 5.1 加一台有 ssh daemon 的机器（mac）

```bash
# 1. 运行时
npm i -g @mori-mori/mcp-ssh-pty

# 2. token（与 VPS hub.json 该 node 一致）
mkdir -p ~/.mori/ssh && echo '<TOKEN>' > ~/.mori/ssh/http-token && chmod 600 ~/.mori/ssh/http-token

# 3. SSH loopback —— connect local 要用（daemon 由 launchd 托管、无 TTY，
#    node-pty 失败后降级为 ssh 连自身 sshd 拿真 PTY）
#    a. Remote Login: ON（系统设置 → 通用 → 共享），allowed users 含当前用户
#    b. 自己的 pub key 进 authorized_keys
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
ssh -o BatchMode=yes "$USER"@127.0.0.1 'echo ok'
#    c. UTF-8（sshd 不从 daemon env 透传 LANG，缺了中文花屏）
grep -q '^export LANG=' ~/.zshenv || printf 'export LANG=en_US.UTF-8\nexport LC_ALL=en_US.UTF-8\n' >> ~/.zshenv

# 4. 反向隧道：独立 launchd 服务，走 vircs-tunnel 别名
#    ~/.mori/ssh/hub-tunnel.sh: ssh -N -R <本机分配的口>:127.0.0.1:27777 vircs-tunnel
#    ~/Library/LaunchAgents/com.mori.hub-tunnel.plist（KeepAlive + RunAtLoad, ThrottleInterval 15）

# 5. daemon 的 launchd plist（模板见仓库 templates/）
launchctl load ~/Library/LaunchAgents/com.mori.mcp-ssh-pty-http.plist
launchctl list | grep mcp-ssh        # pid 非零 + exit=0 = 健康
```

然后 VPS 的 hub.json 加一条 node，`systemctl restart ssh-hub`。

**逐项过一遍（换机/新机每台都不一样的东西）**：

| 项 | 怎么取 | 落到哪 |
|---|---|---|
| node 路径 | `which node`（nvm 每台不同） | plist `ProgramArguments` |
| 用户名 / `$HOME` | `id -un` / `$HOME` | plist |
| SSH keypair（每台一把） | 该机 `~/.ssh/id_ed25519` | 本机 authorized_keys + GitHub |
| token | 与 hub.json 一致 | `~/.mori/ssh/http-token` 600 |
| **反向隧道端口** | **按第二节的表错开** | `hub-tunnel.sh` 的 `-R` |
| Clash 代理口 | air/mini-1 = 7890、mini-2 = 7897 | 隧道脚本开头的 `nc -z` 门控 |
| LANG/LC_ALL | `en_US.UTF-8` | plist `EnvironmentVariables` + `~/.zshenv` |
| sshd | Remote Login ON | 关了则 loopback 和 VPS→该机都 ECONNRESET |

**隧道为什么拆成独立 launchd 服务**：`ExitOnForwardFailure` 是连接级的。hub 口每台唯一 →
可以严格（失败即退、launchd ~15s 重试自愈）；9022 是双机共享的 → 撞了只让 git-tunnel 自己重试，
不连累 hub。塞进同一条连接 = 第二台的 9022 撞死整条 SSH。
隧道脚本开头要**等代理出网再连**：`for i in $(seq 30); do nc -z 127.0.0.1 <Clash口> && break; sleep 2; done`。
key 必须免密（launchd 里没有 ssh-agent）。
⚠️ 这些是 `gui/<uid>` LaunchAgent，**用户 GUI 登录后才起**。要「重启自愈」必须开自动登录 +
Clash 设为登录项（mini-2 实测没开自动登录 → 重启后卡锁屏、隧道全不起）。

### 5.2 加一台只有浏览器、没有 ssh daemon 的机器（windows-4070ti 这种）

当前 hub.json 里的写法是**临时的**：给它一条 node、`url` 填占位
`http://127.0.0.1:1/mcp`，只为让 browser-hub 认出这个浏览器节点。代价是它在
`ssh({action:"list"})` 里**永远显示离线**——这是正常的，不是故障。
要在它上面跑命令走 `ssh({node:"vps", server:"windows-4070ti"})`（经它自建的反向隧道 2201）。

代码里（commit b670f29，**随 2.9.2 发布，npm 上还没有**）已经支持更干净的写法：顶层
`browserNodes` + `via`/`server` 指定「在哪个 ssh node 上执行 up/down」。发版之后把 windows
那条从 `nodes` 挪到 `browserNodes`，加 `via:"vps"` + `server:"windows-4070ti"`，
它就不再污染 ssh 的节点清单。

### 5.3 给一台机器铺浏览器

```bash
# 该机器上。@playwright/mcp 必须 >= 0.0.79：0.0.75 在 --isolated 下不释放已断开会话的 context
# （有头=窗口留在屏幕上，无头=内存泄漏），pw-up.sh 会检查并提醒
npm i -g @playwright/mcp@latest && npx --yes playwright install chromium
# 三个脚本从已铺好的机器抄（air 是参照）：
#   ~/.mori/pw-up.sh   起 daemon（默认有头 + isolated + storage-state，必须 tmux 起，不建隧道；
#                      会先把旧进程杀干净再起、核对监听进程换了新的）
#   ~/.mori/pw-down.sh 只停 daemon，不动隧道（按端口占用者杀到底，不只 tmux kill-session）
#   ~/.mori/ssh/pw-tunnel.sh + com.mori.pw-tunnel.plist   独立 launchd 服务，端口按表改
```

hub.json 的 `browser` 段给 mac 加 `"headed": true`（只影响给模型的提示，有头无头由 pw-up.sh 决定）。

hub.json 给该节点加 `browser` 段（和 ssh 的节点定义共用一份，不用写两遍）：

```json
"browser": { "url": "http://127.0.0.1:2778x/mcp",
             "up": "bash ~/.mori/pw-up.sh", "down": "bash ~/.mori/pw-down.sh",
             "concurrency": 3, "headed": true, "logins": ["..."], "reach": ["公司内网"], "note": "..." }
```

顶层 `browserRoutes` 是按 URL 选机器的规则。**`fallback` 只能指向已经铺好 `browser` 段的节点**，
否则 browser-hub 启动即报错。改完 `systemctl restart browser-hub`。

**为什么用 `--isolated --storage-state` 而不是持久 profile**（2026-08-17 实测）：
持久 profile 是独占的，第二个会话一 navigate 就报 `Browser is already in use`——这才是历史上
「8930 单活口」的真正原因，不只是端口冲突。`--isolated` 每个 client 一份内存 profile，可以并发，
配 `--storage-state <json>` 就能既并发又带完整登录态，而且那份 json 只读、谁也弄不脏。
另外 profile 目录名是**启动参数的指纹**，不显式传 `--user-data-dir` 时参数一改就换一个空 profile
——这是历史上「登录态老是丢」的根因。

---

## 六、排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 某 node `online:false` | 隧道没起 / 机器睡了 / daemon 挂了 | VPS `ss -tlnp \| grep <VPS端口>`；空 → 等 launchd 自愈（~15s），不行就那台 `launchctl kickstart -k gui/$(id -u)/com.mori.hub-tunnel`；有监听 → 查该机 daemon |
| 某 node `online:true` 但命令全超时 | 两种毛病长得一样：**隧道半死**（VPS 侧端口还在监听、转发已经不通）或 **daemon 进程死了**。`list` 的 online 只探端口在不在，探不到后面的进程 | 直接 `curl 127.0.0.1:<VPS端口>/health` 区分：不通就是那一侧真挂了。隧道半死会自愈（VPS 的 sshd `ClientAliveInterval 30`×`CountMax 4`=120 秒判死、释放端口，mac 侧 launchd 15 秒重拉）；**daemon 死了从 VPS 够不到它**，只能在那台机器上跑 `launchctl kickstart -k gui/$(id -u)/com.mori.mcp-ssh-pty-http` |
| windows-4070ti 一直 offline | **正常**，它没有 ssh daemon（第 5.2 节） | 要跑命令走 `node:"vps", server:"windows-4070ti"` |
| 两台只连得上一台 | 反向端口撞了 | 按第二节的表错开，各自 kickstart 隧道 |
| 重启后隧道不回来 | gui LaunchAgent 要登录才起 | 开自动登录 + Clash 设登录项 |
| `EADDRINUSE 27777` | VSCode Remote-SSH 随机抢高位端口（air 上 VSCode 仍在用） | plist 的 wrapper 会检测 `lsof -tiTCP:27777`、是 Code Helper 就 kill 再 exec；然后 `kickstart -k` |
| `connect local` → `posix_spawnp failed` | 旧版没有 loopback 兜底 | 升级包 |
| `connect local` → ECONNRESET | sshd 拒了 loopback 认证 | pub key 进 authorized_keys、chmod 600 |
| hub `connect <node>` → ECONNREFUSED / fetch failed | 该 node daemon 不在线 | 同第一行 |
| token 改了连不上 | hub.json 与该机 `MCP_HTTP_TOKEN` 不一致 | 两边对齐，重启 hub |
| 中文花屏 | 缺 UTF-8 locale | plist `EnvironmentVariables` 和 `~/.zshenv` 都要有 |
| 改了配置没生效 | 常驻服务启动时读一次 | 见第四节的表 |
| 某个会话行为跟别人不一样 | 它的 MCP 进程锁在旧版代码 | 见第三节，比对进程启动时间和包落盘时间 |
| 经隧道 curl playwright 403 | 默认 host 防护 | 起 daemon 加 `--allowed-hosts "*"`（只监听 loopback） |
| 端点路径 | `/mcp` 是 streamable http | `/sse` 是 legacy，别用 |
| 隧道「半死」：VPS 侧端口没了、该机 ssh 进程还在 | 连接断了但没到判死时间，launchd 不重拉 | **等一分钟自愈**（判死 60s + Throttle 15s），别去手工折腾 |

### 换机 / 下线

- 机器下线：`online` 自动变 false，hub 不用改；回来后 launchd 隧道自动重连。
- 永久移除：删 hub.json 那条 node + `bootout` 那台的隧道 job + 停它的 daemon + 重启 hub。
- 旧的 `ssh-mac` 单活直连（27777）已退役，`claude mcp remove ssh-mac` 做过了，27777 永久留空。

---

## 七、几条容易踩的

- **别拿 macbook-air 访问公网页面**：它的浏览器出口是 `107.140.5.40` = VPS 那个住宅 IP（经 Clash
  绕回去）。公网走 mac-mini-2（出口是搬瓦工机房 IP）。见 memory `mac-browser-egress-ip`。
- **公司 skill 的登录态**：`tc-wiki` / `tc-configcenter` / `tc-langfuse` / `jean` / `jean-webshell`
  的 bootstrap 读的是**持久 profile**（`mcp-chrome-*`），不是 storageState。补登录态用
  `~/.mori/browser/relogin.sh`（种回持久 profile + 导出 storageState，一次喂两边）。
- **浏览器隧道别并进 `com.mori.hub-tunnel`**：那条转发的是 ssh daemon，改它要重载服务、
  会瞬断所有会话正在跑的 ssh 调用。拆成独立的 `com.mori.pw-tunnel`。
- **隧道走 `vircs-tunnel` 别名，别自己写 `-J banwagong-us`**：裸 SSH 在公司网每小时 :10-:29
  有 10~30% 失败率。历史教训：`ClearAllForwardings=yes` 会把命令行 `-R` 一起清掉。
- **`pw-up.sh` 要自己解析 playwright-mcp 绝对路径**：三台装的位置不一样（air 在 homebrew、
  mini-2 在 nvm），tmux / launchd 的 PATH 不一定带得上。
- mac 上没有 GNU `timeout`，诊断脚本里别用。
- **mac 的 daemon 默认有头**（2026-08-19 起）：ssh daemon 跑在 launchd 的 gui 域、用户登着 console，
  从 ssh-hub 的 tmux 里起的 Chrome 挂得上 WindowServer——早先"launchd 无 GUI 只能 headless"那句是错的。
  要无头 `PW_HEADLESS=1 bash ~/.mori/pw-up.sh`；没人登图形会话时脚本自动退回无头。
  windows 那台是 WMI 起的进程、拿不到桌面，仍是无头。
- **重起 daemon 别只 `tmux kill-session`**：node 手里有 context 时收到 SIGHUP 不一定退，端口照占，
  新起的报 EADDRINUSE 悄悄失败，而 `nc -z` 看到的 UP 是旧进程的——2026-08-19 就这么"升了 0.0.79、
  跑的还是 0.0.75"验了半小时。新版 pw-up.sh / pw-down.sh 按"谁在监听 8930"杀到底、起完核对 pid。
