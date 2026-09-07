# computer-hub 设计：远程桌面操作统一寻址

状态：**已实现，四台机器铺完、三台跑通**（mac-mini-2 + windows-4070ti + macbook-air），2026-09-06。
mac-mini-1 的服务和隧道都好了，差用户在那台机器上勾两个系统权限（见第十节）。
代码在 `src/computer-*.ts`，服务是 VPS 上的 systemd `computer-hub.service`（127.0.0.1:27793）。

一句话：把「桌面操作跑在哪台机器」从每次手工 ssh 变成一次寻址，做法跟 browser-hub 同构，
配置同样寄生在 `~/.mori/ssh/hub.json`。

---

## 一、上游是什么，不是什么

**是**：OpenAI ChatGPT.app（mac）/ Codex 应用（windows）自带的 `codex app-server`，
以及它加载的官方 computer-use 插件。这个插件持有 macOS 的辅助功能 + 录屏权限
（windows 上是 SendInput + UI Automation + Windows.Graphics.Capture），
负责读界面、截图、注入点击和键盘。

**不是**：任何 OpenAI 模型。app-server 只是个本地 JSON-RPC 服务，hub 自己 initialize、
自己开 thread、自己发 tool call。判断做什么、点哪里，全在 Claude 这边。

协议是 app-server 协议，不是 MCP：websocket 上一帧一条 JSON，`{id, method, params}` 发、
`{id, result}` 回。所以 `computer-client.ts` 是手写的最小客户端，不像 browser-client 那样
直接用 MCP SDK。

握手流程（实测确认）：

```
initialize                         → 拿 codexHome、平台信息
initialized（通知，不带 id）
thread/start  ephemeral:true       → 只开我们要的那几个 server，其余全关
mcpServerStatus/list               → 拿工具清单、确认 server 连上了
mcpServer/tool/call                → 每个动作一次
```

中途上游会**主动发带 id 的请求** `mcpServer/elicitation/request`，就是屏幕上那句
"Allow ChatGPT to use Calculator?"。不回它，这次调用就一直挂着。

---

## 二、架构

```
Claude Code (VPS)
  └─ computer-hub（VPS 常驻，systemd，http 127.0.0.1:27793/mcp）
       │  每个 Claude 会话 = 一份 ComputerClientManager
       │  = 到每台机器一条 websocket = 一个 ephemeral thread
       │
       ├─ mac-mini-2      → ws://127.0.0.1:27786 ─┐ 反向隧道，每台一个独立端口
       ├─ windows-4070ti  → ws://127.0.0.1:27787  │
       ├─ macbook-air     → ws://127.0.0.1:27788  │
       └─ mac-mini-1      → ws://127.0.0.1:27789 ─┘

拉起远端 app-server 时：computer-hub ──借 ssh-hub──→ 那台机器上执行 up 命令
```

VPS 只跑这个转发进程。桌面操作全部发生在远程机器上，屏幕上的动作用户看得见、能随时接手。

---

## 三、和 browser-hub 的三处不同

都是桌面本身的性质决定的，不是实现偷懒。

### 1. 桌面是单一共享面，不能并发

浏览器可以 `--isolated` 给每个会话一个隔离 context，屏幕不行——两个会话同时点会互相打架。
所以 hub 里有一层独占记账：一台机器同时只给一个会话用，第二个会被挡住，并被告知
「对方最后动手在几分钟前」以及还有哪些机器可用。会话结束、`computer_node({action:"release"})`、
或者上游空闲回收，都会把占用还回去。

### 2. 两个平台的工具面不一样

| | mac | windows |
|---|---|---|
| 上游 server | `computer-use`（离散）+ `cua_repl`（js） | `node_repl`（js） |
| 寻址单位 | app（名字 / 路径 / bundle id） | 窗口（`{app, id, title}` 对象） |
| 可访问性树 | 有，元素带编号 | UWP 应用实测拿不到，只有截图；Win32 未验 |
| API | `cua.getApp(...)` → `app.click/typeText/getAXState` | `sky.list_windows/click/type_text/get_window_state` |

原因是上游插件的配置：windows 的 unified-computer-use 把 `CUA_REPL_ENABLED_SURFACES`
写死成 `browser`，桌面那半只能走 `node_repl` + `@oai/sky`。

所以**工具清单是按当前选中的机器算出来的**：没选机器时只报 `computer_node`；
选了 mac 报 11 个（10 个离散 + `computer_js`）；选了 windows 只报 `computer_js`。
报一份"通用清单"会让模型在 windows 上调到不存在的工具。

### 3. 授权问询要有人答

上游把 "Allow ChatGPT to use X?" 作为带 id 的请求发过来。hub 按节点的 `approve` 策略答：

- `low`（默认）：上游标了 `riskLevel: low` 的同意；没标风险等级但**是本次调用引出来的
  应用访问授权**也同意（判据见下）；其余一律拒绝。
- `never`：一律拒绝。
- `always`：一律同意。

**为什么不能只看 riskLevel**：两套上游的元数据不一样。`cua_repl` 那套带
`riskLevel=low` 和结构化的 `tool_params_display`；离散那套**什么都不带**，
只有一句 "Allow ChatGPT to use Calculator?"。只认 riskLevel 的话，离散工具一调就被自己拒掉
（第一版就是这么错的）。所以补了第二条判据：消息形如 "Allow … to use …"，
而且**我们自己发出去的那次调用正等着**，那就是这次调用引出来的授权，放行。

不管同意还是拒绝，问了什么、怎么答的、为什么，都会拼在工具结果最前面回给模型——
不闷声放行。授权只在本次连接有效，不设永久授权（上游的 `persist: ["always"]` 我们不用）。

---

## 四、thread/start 的配置是合并语义

这条踩过：`config.mcp_servers` 是**合并**进那台机器的 `~/.codex/config.toml`，不是替换。
不显式关掉的话，用户自己配的 server（ssh、trail、playwright…）会跟着我们的 thread 一起
被拉起来——既费那台机器的资源，又等于替用户启动了他自己的工具。

所以建连前先经 ssh-hub 在那台机器上读一次 `config.toml` 里的 `[mcp_servers.*]` 段名，
把它们逐个置 `enabled: false`，再开我们要的那个。读不到就退回只关我们知道名字的那几个
（少关几个不影响功能，不该因此连不上）。

---

## 五、配置格式

在 `~/.mori/ssh/hub.json` 的节点上加 `computer` 段：

```json
{
  "name": "mac-mini-2",
  "url": "http://127.0.0.1:27780/mcp",
  "token": "...",
  "computer": {
    "url": "ws://127.0.0.1:27786",
    "platform": "mac",
    "up": "launchctl kickstart gui/$(id -u)/com.mori.cua-server",
    "down": "launchctl kill TERM gui/$(id -u)/com.mori.cua-server",
    "approve": "low",
    "note": "……给模型看的说明"
  }
}
```

`platform` 必填，决定工具面和 thread 配置。没有自己 ssh daemon 的机器用
`via` + `server` 借别人的通路跑 up/down（跟 browser-hub 一样）。

---

## 六、对外的工具

所有工具带 `computer_` 前缀。上游的名字是 `click` / `drag` / `type_text` 这种通名，
直接透传会跟别的 MCP 服务撞名，也让模型分不清点的是网页还是桌面。

- `computer_node`：`list` / `connect` / `status` / `up` / `release`
- mac：`computer_get_app_state`、`computer_list_apps`、`computer_click`、`computer_type_text`、
  `computer_press_key`、`computer_set_value`、`computer_scroll`、`computer_drag`、
  `computer_select_text`、`computer_perform_secondary_action`、`computer_js`
- windows：`computer_js`

截图作为 MCP 的 image block 直接回传（mac 上一张 app 窗口截图约 35KB base64），
不落文件、不用再搬一次。

---

## 七、每台机器上装了什么

**mac-mini-2**

- `~/.mori/cua-up.sh` + launchd `com.mori.cua-server`：app-server 常驻在 8940。
  必须由 launchd 的 gui 域拉起——辅助功能和录屏权限绑在图形会话上，
  从 ssh 的子进程直接起会拿不到。
- `~/.mori/ssh/cua-tunnel.sh` + launchd `com.mori.cua-tunnel`：VPS 27786 → 本机 8940。
  独立一条，不并进 `com.mori.pw-tunnel`（改一条不影响另一条）。

**windows-4070ti**

- `C:\Users\lucas\.mori\cua-up.ps1` + 任务计划 `MoriCuaServer`：app-server 常驻在 8940。
  **必须是 Interactive 身份**：WMI `Win32_Process.Create` 起的落在会话 0（没有桌面），
  ws 能连、`cua_repl` 也报 connected，但一调 `js` 就 `0xC0000142`（STATUS_DLL_INIT_FAILED）崩掉。
  判据：`(Get-Process -Id <监听进程>).SessionId` 要是 1。
  注意这跟本机另外两个 daemon 的起法不同（那两个走 WMI，它们不需要桌面）。
- `C:\ProgramData\ssh\tunnel\config-cua` + `cua-tunnel.ps1` + 任务计划 `MoriCuaTunnel`：
  VPS 27787 → 本机 8940，SYSTEM 身份开机拉起，经搬瓦工跳板（VPS 边界只放行固定源 IP）。

---

## 八、已知限制和坑

- **锁屏时什么都读不到**。macOS 锁屏下窗口服务器不给任何窗口，`get_app_state` 报
  `cgWindowNotFound`。mac-mini-2 已关掉自动锁屏。人手动锁了的话要先解锁——
  可以用 hub 自己解：读 `com.apple.loginwindow` 的树，先按一个非修饰键让密码框出现
  （只按 shift 会报 `keyPressIncludedNoNonModifierKeys`），再输密码回车。
- **元素编号每次调用都会重排**。动手前必须用最新一次返回的树，别拿上一轮的编号。
- **windows 上 UWP 应用读不到可访问性树**，只有截图。普通 Win32 应用还没验（记事本没装，
  任务管理器当时最小化、激活会抢焦点）。
- **windows 每个动作都会单独弹一次授权问询**，mac 是按 app 一次。
- **上游 repl 的沙箱不让写文件**（`EPERM`，`~/.codex` 下也不行）。要落盘只能在客户端侧
  接住 image block 自己写。
- **js 第一次调用会回一份 17KB 的接口文档**（上游自动附带）。目前原样回传，
  以后可以在 hub 里缓存掉。
- **托管 daemon 那条路走不通**：ChatGPT.app 自己常驻着一个 app-server
  （`~/.codex/app-server-control/app-server-control.sock`），用官方 `app-server proxy --sock`
  能连上，但对 `initialize` 一个字不回，估计只认它自己的客户端。所以我们自己起一个。

---

## 九、验证记录（2026-09-06）

- mac：`computer_node` 各 action、10 个离散工具透传、`computer_js`、授权问询自动同意并如实报告、
  截图作 image block 回传（35KB base64）、独占记账、release 释放。
  端到端做过：读计算器状态 → 点按钮 → js 里批量输入并读回结果。
- windows：`connect` 后工具面正确收窄成 `computer_node` + `computer_js`；
  `sky.list_windows()` 读到真实窗口列表。
- 性能对比（同一台 mac，同样的读状态动作）：

  | 路径 | 建会话 | 单次调用 |
  |---|---|---|
  | 旧 skill（每步一次 ssh exec + 文件轮询） | 约 20s | 3~6s |
  | computer-hub（websocket 直连） | 0.3~3s | 0.1~0.4s（windows 约 3s） |

- 三个 hub 的配置共读一份 hub.json，改完这份后 ssh-hub / browser-hub / computer-hub
  三个 loader 都验过能正常加载（老代码对未知键不做校验）。

---

## 十、四台机器的现状与两个版本坑

### 版本：三台 mac 现在都是 26.901

原来三台各不相同，踩出一串问题，2026-09-06 全部拉齐：

| | mac-mini-2 | macbook-air | mac-mini-1 |
|---|---|---|---|
| 之前 | 26.901 | 26.715（7 月） | 没装 |
| 现在 | 26.901.51231 | 26.901.51231 | 26.901.51231 |

**升级包从哪来**：应用自己的 Sparkle 更新源是
`https://persistent.oaistatic.com/codex-app-prod/appcast.xml`（从
`~/Library/Caches/com.openai.codex/Cache.db` 里挖出来的，Info.plist 和二进制里都没写）。
里面直接给各版本的 zip 直链，如 `ChatGPT-darwin-arm64-26.901.51231.zip`（567MB）。
air 的更新器自己检查过、认为它的 5551 已是最新，多半是灰度没轮到，所以直接装。
官网 `persistent.oaistatic.com/sidekick/public/ChatGPT.dmg` 是**另一条线**的旧包
（1.2026.183，162MB），里面根本没有 codex 和插件目录，别用它。

**旧版慢一个数量级**（air 同一台机器，升级前后）：

| | 26.715 | 26.901 |
|---|---|---|
| 首次读状态 | 18.8s | 1.6s |
| 稳态读状态 | — | 1.0s |
| 工具面 | 只有 10 个离散工具 | 另有 `computer_js` |

为兼容旧版加的三处（驱动路径探测、`runtimeStatus` 可能缺失、启动超时分两档）保留着，
以后哪台机器的应用再漂移不用改代码。

### 建连慢的真正原因：codex_apps

air 升级后单次调用已经 1 秒，但建连仍要 20 多秒，mini-2 只要 2 秒。分段计时发现卡在
`mcpServerStatus/list`：它要等**所有** server 起完，其中有个内置的 `codex_apps`
（连接器运行时，94 个工具，要联网拉账号里的 app 清单），公司那台 24 秒、家里那台 2 秒。

`codex_apps` 关不掉——传 `enabled: false` 会让 `thread/start` 直接报
`invalid transport in mcp_servers.codex_apps`。所以改成**不等它**：拉清单只给 8 秒，
超时就先按静态清单开工，后台等真清单回来再替换。air 的建连因此 25 秒降到 10 秒。

### mac-mini-1 差的那一步：两个系统权限

服务、隧道、配置都铺好了，`computer_list_apps` 秒回，但 `computer_get_app_state` 会挂住——
读界面要辅助功能、截图要屏幕录制，新装的应用第一次用时 macOS 弹一个要人点的框，
**没点之前调用不报错，就是一直等**。

要用户在 mac-mini-1 上做一次：系统设置 → 隐私与安全性 → 辅助功能 / 屏幕录制，把 ChatGPT 勾上。
hub 现在会在这种超时上附一句针对性提示，不用再猜。
