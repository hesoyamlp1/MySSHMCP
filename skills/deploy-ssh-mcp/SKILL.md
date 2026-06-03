---
name: deploy-ssh-mcp
description: "Use this skill when deploying / extending the multi-mac ssh-hub setup, or debugging it. Architecture: ONE `ssh-hub` MCP on the VPS (`mcp-ssh-pty --hub`, reads ~/.mori/ssh/hub.json) fans out to many nodes — the VPS itself (in-process) plus each mac running an `--http` daemon exposed over its reverse tunnel on a DISTINCT VPS port. Triggers: 'add a mac to ssh-hub / 加一台 mac', 'setup mcp-ssh-pty hub', 'new mac daemon', 'node online false / mac 连不上 / list 离线', 'two macs only one works / 反向隧道端口冲突', 'mac mcp daemon failed / EADDRINUSE 27777', 'connect local broken on mac', 'VSCode grabbed port 27777', 'switch / migrate mac', 'register ssh-hub'. Each mac node = the `--http` daemon deploy (launchd, token, sshd-loopback); the hub layer = hub.json + distinct ports + register ssh-hub."
---

# Deploy: ssh-hub (one MCP) + per-mac `--http` daemons

## Architecture (hub model)

Claude Code runs on the VPS and registers **one** MCP: `ssh-hub` (`mcp-ssh-pty --hub`). It reads `~/.mori/ssh/hub.json` and routes to nodes. Each mac still runs its own `--http` daemon (closest to its LAN); the VPS joins as an in-process node.

```
Claude Code (VPS)
  └─ ssh-hub (stdio) = mcp-ssh-pty --hub  →  ~/.mori/ssh/hub.json
       ├─ in-process 直连           → vps          (VPS 本机 shell)
       ├─ http://127.0.0.1:27777/mcp → macbook      (--http daemon, 本地 27777)
       └─ http://127.0.0.1:27778/mcp → mac-mini-1   (--http daemon, 本地 27777)

mac daemon 本地都听 27777；反向隧道把它错开暴露到 VPS 不同端口：
  macbook    ~/.ssh/config: RemoteForward 27777 localhost:27777
  mac-mini-1 ~/.ssh/config: RemoteForward 27778 localhost:27777
```

**两层寻址**：hub 的 `node` 参数选哪台机器；现有的 `server` 参数选该机器内部哪台（local / 它的内网机）。

**为什么**：一条注册管全部；每台 mac 仍是自己的 daemon 干活 → 一跳 sftp、本地直连、各自 notes/shortcuts；多台 mac 的 PTY 可同时活着（各自独立下游连接）；`list` 逐 node 探活显示 online。

## 端口纪律（核心，否则只能连一台）

VPS 上一个端口只能被一条反向隧道绑定。每台 mac 的 daemon **本地都用 27777**（plist/防抢逻辑不用每台改），错开的是**反向隧道暴露到 VPS 的端口**：

| 机器 | mac 本地 daemon | mac `~/.ssh/config`（Host vircs） | hub.json url |
|---|---|---|---|
| macbook | 27777 | `RemoteForward 27777 localhost:27777` | `http://127.0.0.1:27777/mcp` |
| mac-mini-1 | 27777 | `RemoteForward 27778 localhost:27777` | `http://127.0.0.1:27778/mcp` |
| mac-mini-2 | 27777 | `RemoteForward 27779 localhost:27777` | `http://127.0.0.1:27779/mcp` |

约定：VPS 暴露端口从 27777 顺延（27778、27779…）。两台都写 `27777 localhost:27777` → 第二台静默失败（mac 的 ssh 日志 `remote port forwarding failed for listen port 27777`）= 「只能连一台」的根因。

## hub.json（VPS，含 token，chmod 600）

`~/.mori/ssh/hub.json`（模板见仓库 `hub.example.json`）：

```json
{ "nodes": [
  { "name": "vps", "local": true },
  { "name": "macbook",    "url": "http://127.0.0.1:27777/mcp", "token": "<同该 mac MCP_HTTP_TOKEN>" },
  { "name": "mac-mini-1", "url": "http://127.0.0.1:27778/mcp", "token": "<同该 mac MCP_HTTP_TOKEN>" }
] }
```

- `local:true` 的节点是 VPS 自己（in-process，不用起 daemon）。
- 远程节点的 `token` 必须与那台 mac daemon 的 `MCP_HTTP_TOKEN` 一致。

## 注册 ssh-hub（VPS）

```bash
claude mcp add ssh-hub -- mcp-ssh-pty --hub
# 开发期指向源码：claude mcp add ssh-hub -- node /path/to/MySSHMCP/dist/index.js --hub
claude mcp list | grep ssh-hub   # ✓ Connected
```

> MCP 工具在会话启动时加载：注册后要**新开会话**才看得到 `ssh-hub__ssh` / `ssh-hub__sftp`。

## 日常使用

```
ssh({action:"list"})                                  # 所有 node + online + 各 node 的 server 名
ssh({action:"list", onlineOnly:true})                 # 只列在线 node
ssh({node:"macbook", action:"connect", server:"local"})   # 连 macbook 本机；之后不带 node 都走它
ssh({command:"..."})                                  # 在当前 node 当前连接上执行
ssh({node:"mac-mini-1", action:"connect", server:"0.2"})  # 连 mac-mini-1 背后的内网机（该 mac 一跳）
```

切 node 不影响其它 node 上正在跑的东西（长任务照例丢 tmux）。connect 一个离线 node 会返回「daemon 可能不在线」而非裸 ECONNREFUSED。

---

# 单台 mac node 的部署（`--http` daemon）

每个远程 node = 一台 mac 跑 `mcp-ssh-pty --http`。下面是单台 mac 的完整部署（加新 mac 就重复这套，**只改反向隧道端口**）。

## 1. 安装运行时

```bash
npm i -g @mori-mori/mcp-ssh-pty
cat "$(npm root -g)/@mori-mori/mcp-ssh-pty/package.json" | grep version
```

## 2. token

```bash
mkdir -p ~/.mori/ssh
echo '<TOKEN>' > ~/.mori/ssh/http-token   # 与 VPS hub.json 该 node 的 token 一致
chmod 600 ~/.mori/ssh/http-token
```

## 3. SSH loopback（`connect local` 需要）

mac 的 daemon 由 launchd 托管 → 无 TTY → node-pty 失败，会自动降级为 ssh 连自身 sshd（拿真 PTY）。需要：

```bash
# a. Remote Login: ON（System Settings → General → Sharing），allowed users 含当前用户
# b. 自己的 pub key 进 authorized_keys
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
ssh -o BatchMode=yes "$USER"@127.0.0.1 'echo ok'      # 验证

# c. UTF-8 locale（sshd 不从 daemon env 透传 LANG，缺了中文回显花屏）
grep -q '^export LANG=' ~/.zshenv 2>/dev/null || cat >> ~/.zshenv <<'EOF'
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
EOF
```

## 4. 反向隧道（端口按上表错开！）

`~/.ssh/config` 的 `Host vircs` 块：

```
RemoteForward <VPS端口> localhost:27777     # macbook=27777 / mini1=27778 / mini2=27779
```

起隧道：`ssh -fN vircs`（或让 VSCode Remote-SSH 维持）。

## 5. ssh-servers.json（这台 mac 自己的内网拓扑）

`~/.mori/ssh/ssh-servers.json` —— 这台 mac 能直连的内网机 + 它的 shortcuts/hints/notes。模板见 `ssh-servers.example.json`。

## 6. launchd plist（带 VSCode 抢端口的自动 kill）

VSCode Remote-SSH 启动会随机抢高位端口（含 27777）→ daemon EADDRINUSE。plist 的 wrapper 检测 `lsof -tiTCP:27777`，是 Code Helper/Electron 就 kill 再 exec daemon。模板：`templates/com.mori.mcp-ssh-pty-http.plist.template`；自动化：`scripts/migrate-mac1.sh`（探测 nvm node 路径，每台不同）。

- plist `EnvironmentVariables` 必须含 `LANG`/`LC_ALL=en_US.UTF-8`，否则 `connect local` 起的 zsh 中文 mojibake。
- daemon 本地端口保持 27777（不用每台改）。

```bash
launchctl load ~/Library/LaunchAgents/com.mori.mcp-ssh-pty-http.plist
launchctl list | grep mcp-ssh        # pid 非零 + exit=0 = 健康
```

## 7. per-mac drift checklist（换机/新机逐项过）

| 项 | 怎么取 | 落到哪 |
|---|---|---|
| Node 路径 | `which node`（nvm 每台不同） | plist `ProgramArguments` |
| 用户名 / `$HOME` | `id -un` / `$HOME` | plist HOME/路径 |
| SSH keypair（每台单独一把） | 这台的 `~/.ssh/id_ed25519` | (a) 本机 authorized_keys（loopback）(b) GitHub（git pull 走 SSH） |
| Token | 与 VPS hub.json 该 node 一致 | `~/.mori/ssh/http-token` 600 |
| **反向隧道端口** | **按端口表错开** | `~/.ssh/config` `RemoteForward <VPS端口> localhost:27777` |
| LANG/LC_ALL | 固定 `en_US.UTF-8` | plist EnvironmentVariables + `~/.zshenv` |
| sshd | Remote Login ON, 含当前用户 | 关了 loopback / VPS→mac 都 ECONNRESET |

## kickstart vs bootout

```bash
# 改了 ssh-servers.json / 升级 npm 包：重启进程即可
launchctl kickstart -k gui/$(id -u)/com.mori.mcp-ssh-pty-http
# 改了 plist 本身（env/args/KeepAlive）：必须 bootout + bootstrap，否则缓存定义不刷新
PLIST=~/Library/LaunchAgents/com.mori.mcp-ssh-pty-http.plist
launchctl bootout gui/$(id -u) "$PLIST"; launchctl bootstrap gui/$(id -u) "$PLIST"
```

---

## Troubleshooting

| 现象 | 原因 | 处理 |
|---|---|---|
| `list` 里某 node `online:false` | 反向隧道没起 / mac 睡了 / daemon 挂了 | VPS `ss -tlnp \| grep <VPS端口>`；空 → mac 重连 `ssh -fN vircs`；有监听 → 看 mac daemon |
| 两台 mac 只连得上一台 | 反向端口撞了 | 每台错开（见端口表），重起隧道 |
| `EADDRINUSE 27777` (mcp-http.err) | VSCode 抢了端口 | 用带 auto-kill 的 plist wrapper；`launchctl kickstart -k …` |
| `connect local` → `posix_spawnp failed` | 旧版无 loopback 兜底 | 升级 npm 包 |
| `connect local` → ECONNRESET | sshd 拒了 loopback 认证 | 自己 pub key 进 authorized_keys；chmod 600 |
| hub `connect <node>` → ECONNREFUSED/fetch failed | 该 node daemon 不在线 | 同「online:false」一行 |
| token 改了 hub 连不上 | hub.json token 与 mac MCP_HTTP_TOKEN 不一致 | 两边对齐 |
| 中文输出花屏 | 缺 UTF-8 locale | plist EnvironmentVariables + `~/.zshenv` 都要有 |

## 换机 / 加机

- mac 下线：它的 `online` 自动变 `false`，hub 不用改；回来重连隧道即恢复。
- 加新 mac：跑一遍「单台 mac node 部署」（端口表往下取一个），在 hub.json 加一条 node，`launchctl kickstart` 不需要（是新机），VPS 侧无需重启 ssh-hub（下次 list 即探到；已在跑的会话需新开才看到新 server 列表变化）。
- 永久移除：删 hub.json 里那条 node + 那台 mac 的 RemoteForward 行 + 停它的 daemon。

## 旧的单机直连（ssh-mac，HTTP 每台一注册）

`claude mcp add --transport http ssh-mac http://127.0.0.1:27777/mcp --header "Authorization: Bearer <TOKEN>"` 仍可用作**单台 mac 的直连**（不经 hub）。多机统一管理用 hub；过渡期两者可共存（hub 复用同一个 daemon）。
