# browser-hub 设计：远程浏览器统一寻址

状态：**设计稿，待评审**。写于 2026-08-17。
一句话：把「浏览器跑在哪台机器」这件事从每次手工操作变成一次寻址，做法跟 ssh-hub 同构，代码大部分是复用。

---

## 一、现在的四个问题

| 问题 | 根因 |
|---|---|
| 换机器要先 `pw-down` 再 `pw-up` | VPS 上 8930 是单活口，三台 mac 抢同一个端口 |
| 每次要人工 `/mcp` 重连 playwright | Claude 的 MCP 直连 `127.0.0.1:8930`，daemon 没起时这个地址根本不存在 |
| VPS 本机浏览器和远程浏览器互斥 | VPS 也装了 playwright（0.0.68 + chromium），但 `playwright` 这个 MCP 名被 8930 占着（新方案的处置是 VPS 干脆不跑浏览器，见第三节末） |
| 每次都要当场判断该用哪台机器 | 没有任何"哪个站去哪台"的规则 |

前三个是同一个设计造成的：**MCP 直连了隧道端口**。一次改掉。

---

## 二、实测结论（2026-08-17，在 macbook-air 上，`@playwright/mcp` 0.0.75）

这一节是全文的地基，每条都实际跑过，不是推断。

**1. 持久 profile 是独占的。** 两个 MCP session 连同一个 daemon，第二个一 navigate 就报：

```
Error: Browser is already in use for
/Users/linsuki/Library/Caches/ms-playwright/mcp-chrome-87991ad,
use --isolated to run multiple instances of the same browser
```

而且争抢时行为是乱的：先来的那个 session 后续调用变成空响应，后来的反而拿到了浏览器。

**2. `--isolated` 可以并发，而且完全隔离。** 一个 daemon、两个 session 同时 navigate 都成功，A 看到 `about:blank#ISO-A`、B 看到 `#ISO-B`，互不影响。

**3. `--isolated --storage-state <file>` 能把登录态注入并发 session。** 从持久 profile 导出 14 个 cookie（`.17u.cn`、`tccommonht.17usoft.com`、`tcsk`、`tchl`、`.jean.corp.elong.com` 等），注入后两个并发 session **各自都读到完整 14 个**。
**并发和登录态可以同时成立** —— 这条推翻了原本要做的租约/排队机制，是整个设计里最大的简化。

**4. profile 目录名是启动参数的指纹，参数一变就换一个新 profile。** air 上现在躺着 9 个 profile、合计约 2GB：

```
790M mcp-chrome-8074aa6   git.17usoft.com / langfuse / rds.tcdba   （今天在用）
353M mcp-chrome-8a0a852   98 个 cookie、office.17u.cn              （8-09）
306M mcp-chrome-271b6aa   tccommon 三个环境                        （8-09）
159M mcp-chrome-33da8b6   管家系 .17u.cn/tccommonht/tchl/tcsk      （今天在用）
148M mcp-chrome-87991ad   45 个 cookie，pw-up 默认落的那个          （8-09）
117M mcp-chrome-98d85d2 / 64M 06c6cdf / 59M 42b5507 / 54M 293d3d3
```

`pw-up.sh` 没有显式指定 `--user-data-dir`，所以**改一次启动参数，登录态就"丢"了**——skill `internal-web-via-mac` 里记的"哪天停在登录页就重新登一次"，根因是这个，不是 cookie 过期。

**5. 登录态散落在多个 profile 里，而且今天有两个 profile 同时在被写。** 说明 `tc-wiki`、`tc-langfuse`、`guanjia-doc`、`jean` 这些跑在 mac 上的 skill 各自起自己的 playwright、各攒一份登录态，互相不知道。

**6. 工具面：23 个工具，schema 合计 17KB。** 它们在 Claude Code 里是 deferred 工具，只有名字常驻上下文（约 500 字节），schema 要 `ToolSearch` 才加载 —— 所以原样透传的上下文成本可以接受。

---

## 三、架构

```
Claude Code (VPS)  ←── MCP 地址永不变，不用再 /mcp 重连
  └─ browser-hub（VPS 常驻，systemd，http 127.0.0.1:27791/mcp）
       │
       │  每个 Claude 会话 = 一份独立的 BrowserClientManager
       │  = 一条到上游 playwright 的独立 MCP session
       │  = 一个独立 browser context（互不串台）
       │
       ├─ macbook-air    → 127.0.0.1:27781 ─┐  公司内网 + 公司登录态
       ├─ mac-mini-1     → 127.0.0.1:27782  ├ 各自独立端口的反向隧道
       ├─ mac-mini-2     → 127.0.0.1:27783 ─┘  家里内网 + 公网兜底
       └─ windows-4070ti → 经 2201（以后再说，有 GPU 可跑 headful）

拉起远端 daemon 时：browser-hub ──借 ssh-hub──→ 那台 mac 上执行 pw-up
```

**VPS 本机不跑浏览器**（2026-08-17 定）。hub 进程本身留在 VPS（它只转发 MCP 消息，约 100M），但一个 chromium 都不落这台：

- 一个 isolated context 就是一个完整 chromium 实例，300~500MB。VPS 7.7G 内存、常态剩 3~4G、七八个会话在跑、30 天 OOM 过 3 次——两三个会话同时看页面就是 1~1.5G，直接踩到 OOM 边缘。
- 这本来就是 CLAUDE.md 那条红线的适用范围（>500M 内存的活不在 VPS 跑）。
- 三台 mac 各 16G 基本闲着，公网页面放 mac-mini-2（家宽出口、家里那台闲得最彻底）比放 VPS 合适。
- 代价是**没有本机兜底**了：三台 mac 全离线时浏览器能力完全不可用。见第十一节。

三件现成的东西直接复用：

- **mac 上的隧道**：`launchctl com.mori.hub-tunnel` 现在只转一条 `-R 27780:127.0.0.1:27777`，加一条 `-R 27783:127.0.0.1:8930` 即可。
- **`hub.json` 的节点定义和 token**：不新建一份节点清单，在原节点上加 `browser` 段。
- **`index.ts` 的 `serveHttp`**：现有 HTTP 会话层已经是"每个 MCP session 各自一份 manager"，正是需要的语义，一行不用改。

**单活口问题从根上消失**：每台 mac 的 playwright 只在自己 loopback 监听，隧道到 VPS 的端口各不相同。air 上开着公司 wiki、mini-2 上开着家里 NAS，两个浏览器同时活着，切机器不影响对方。

**拉起远端 daemon 借 ssh-hub 做执行代理**：browser-hub 自己不需要任何 ssh 能力，它调用同一台机器的 ssh daemon 跑 `pw-up`。两个 hub 共享 `hub.json`，职责不重叠。

---

## 四、并发与登录态模型（核心）

每台机器**只跑一个** playwright daemon，参数固定为：

```
playwright-mcp --port 8930 --host 127.0.0.1 --headless \
  --isolated \
  --storage-state ~/.mori/browser/state/company.json \
  --allowed-hosts "*"
```

- `--isolated`：每个连上来的 MCP client 各自一个内存 profile → 无限并发（受内存限制），互不干扰。
- `--storage-state`：登录态从一个共享的只读 cookie 文件注入 → 每个会话都有登录态，而且**谁也弄不脏它**（内存 profile 用完即弃）。

于是：

| | 旧方案（持久 profile） | 新方案（isolated + storage-state） |
|---|---|---|
| 并发会话 | 1（第二个报 already in use） | 多个，实测 2 个并发正常 |
| 登录态 | 有，但随参数漂移 | 有，来自固定文件 |
| 会话互相污染 | 会（共用一个 profile） | 不会 |
| 磁盘 | 每 profile 100~800M | 一个 4KB 的 json |

**代价**：登录态需要单独维护（见第八节），而且 `storageState` 只带 cookie —— 实测 `origins`（localStorage）导出为 0，靠 localStorage 存 token 的站注入不全。这类站要走第八节的独占持久模式。

---

## 五、配置格式

不新建配置文件，在 `~/.mori/ssh/hub.json` 的节点上加 `browser` 段，顶层加 `browserRoutes`：

```json
{
  "nodes": [
    {
      "name": "macbook-air",
      "url": "http://127.0.0.1:27778/mcp",
      "token": "...",
      "browser": {
        "url": "http://127.0.0.1:27781/mcp",
        "up": "bash ~/.mori/pw-up.sh",
        "concurrency": 3,
        "logins": ["管家/wiki(.17u.cn)", "git.17usoft.com", "langfuse", "jean"],
        "reach": ["公司内网"]
      }
    },
    {
      "name": "mac-mini-2",
      "url": "http://127.0.0.1:27780/mcp",
      "token": "...",
      "browser": {
        "url": "http://127.0.0.1:27783/mcp",
        "up": "bash ~/.mori/pw-up.sh",
        "concurrency": 3,
        "logins": [],
        "reach": ["家里内网 192.168.31.x", "公网（家宽出口）"],
        "note": "公网页面的兜底机器；进不了公司内网"
      }
    }
  ],
  "browserRoutes": [
    { "match": ["*.17u.cn", "*.17usoft.com", "*.corp.elong.com"], "node": "macbook-air", "fallback": "mac-mini-1" },
    { "match": ["192.168.31.*", "*.local"], "node": "mac-mini-2" },
    { "match": ["*"], "node": "mac-mini-2", "fallback": "macbook-air" }
  ]
}
```

`logins` 是给我看的：`browser_node({action:"list"})` 会把它显示出来，我选机器时才知道哪台有哪个站的登录态，不用猜。

---

## 六、工具接口

**23 个原生 `browser_*` 工具原样透传**（名字、schema 都不改），另加一个选机器的工具：

```js
browser_node({action:"list"})                    // 每台 online + 有没有活着的浏览器 + 有哪些登录态
browser_node({action:"connect", node:"macbook-air"})  // 之后本会话所有 browser_* 都走 air
browser_node({action:"status"})                  // 当前会话用的是哪台、页面在哪
browser_node({action:"down", node:"..."})        // 停掉那台的 daemon（省内存）

browser_navigate({url:"https://wiki.17u.cn/..."})     // 没 connect 过时按 URL 自动路由到 air
browser_snapshot() / browser_evaluate({...}) / ...    // 原生工具，照常用
```

两个设计点：

- **自动路由**：没显式 connect 过时，`browser_navigate` 按 `browserRoutes` 匹配 URL 自己选机器，并在返回里说明"已自动路由到 macbook-air（规则 `*.17u.cn`）"。这是真正解决"每次都要指定"的那一环。
- **工具列表怎么来**：优先在启动时从任一在线上游拉 `tools/list`；全都离线时用**内置的 schema 快照**（23 个工具、17KB，从 0.0.75 拉的）。否则 hub 冷启动时上游都没起，Claude 那边会看到一个空工具列表。

---

## 七、daemon 生命周期

- **按需拉起**：`connect`（或自动路由首次命中）时，hub 探那台的 browser url 是否通；不通就借 ssh-hub 在那台机器上跑 `up` 命令，轮询到端口起来（约 3~6 秒），再建立上游 MCP session。
- **空闲回收**：hub 记每台最后一次调用时间，超过阈值（建议 30 分钟）在那台机器上跑 `pw-down`。一个 isolated context 带一个浏览器实例，量级 300~500MB，mac 16G 上不回收也不致命，但没必要一直占。
- **并发上限**：按 `concurrency` 限制同一台机器上的活跃会话数，超了明确报"air 上已有 3 个会话在用浏览器，换 mac-mini-1 或稍后再试"，不要变成上游的费解报错。
- **IP 卫生的红线要跟着搬**：原来的规矩是"爬取别落 VPS（住宅 IP）"。现在兜底机器换成 mac-mini-2，而**家宽同样是住宅 IP**——这条红线对 mini-2 一样成立，不是只管 VPS。路由表兜底那条只给一次一两页的轻量访问；成规模抓取要显式指定机房 IP 的机器（野草云美国，`curl ip-api.com/json/` 看 `hosting: true`），那台还没装 playwright，要用再说。

---

## 八、登录态维护

这是唯一需要人参与的环节，一次登录管几天到几周。

**初始化 / 刷新**（`browser_node({action:"relogin", node:"macbook-air"})` 打印步骤，人在 mac 上做）：

1. 在那台 mac 上起一个**独占的持久 profile daemon**，headful，`--user-data-dir` 显式固定为 `~/.mori/browser/profile/company`（不再让 hash 漂移）。
2. 用户开盖，在弹出的浏览器里登一次 SSO。
3. 脚本从该 profile 导出 storageState 到 `~/.mori/browser/state/company.json`，权限 600。
4. 关掉持久 daemon，isolated daemon 重启加载新 state。

导出用 playwright 现成的库（air 上在 `/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright`）：

```js
const ctx = await chromium.launchPersistentContext(profileDir, {headless:true});
await ctx.storageState({path: statePath});
await ctx.close();
```

**过期怎么发现**：hub 不主动探测（探测要访问内网页面，成本高又不可靠）。约定由调用方判断——落到登录页时 `browser_node({action:"relogin"})`。

**安全**：`state.json` 是**明文的公司 SSO cookie**。权限 600、不入 git、不进 scratchpad、不跨机传（每台机器维护自己的）。本次验证用的临时副本已经 shred 删除。

---

## 九、实现清单

| 文件 | 内容 | 估计行数 |
|---|---|---|
| `src/browser-config.ts` | 读 hub.json 的 browser 段 + browserRoutes，仿 `hub-config.ts` | ~70 |
| `src/browser-client.ts` | 每会话一份，管到各上游 playwright 的 MCP 连接；仿 `hub-client.ts`，去掉 in-process 分支 | ~130 |
| `src/browser-hub.ts` | 透传 tools/list + 按 node 转发 + `browser_node` 工具 + URL 自动路由 + 按需拉起 | ~260 |
| `src/browser-tools-snapshot.json` | 23 个工具的 schema 快照，冷启动兜底 | 17KB |
| `src/index.ts` | 加 `--browser-hub` 分支，复用现有 `serveHttp` | ~25 |

约 500 行新代码，**不改动 ssh-hub 现有任何一行**。

**进程形态：独立进程**（2026-08-17 定）。`mcp-ssh-pty --browser-hub --http 127.0.0.1:27791`，systemd 一个单独的 service，约 100M 内存。不合进现有 ssh-hub 进程——合并能省这 100M，但要改 `serveHttp` 按 path 分派，那是跑在生产上的代码，不值得为 100M 去动它。这也是 VPS 上唯一因 browser-hub 增加的常驻开销（chromium 全在 mac）。

---

## 十、迁移步骤

1. **一台机器先跑通**（air）：改 `pw-up.sh` 成 isolated + 固定 state 路径、不再建隧道；隧道那条并进 `com.mori.hub-tunnel`（加 `-R 27781:127.0.0.1:8930`）。
2. **初始化 air 的登录态**：从现有 `33da8b6`（管家系）和 `8074aa6`（git/langfuse）各导一次，合并成一份 state.json。两份 cookie 域不重叠，可以合。
3. **VPS 侧**：装 browser-hub，systemd 起来，`claude mcp add` 注册 `browser-hub`，把老的 `playwright`（指向 8930 那个）删掉。**这一步之后需要最后一次 `/mcp` 重连，往后再也不用。**
4. 验证 air 这个 node 端到端，包括并发（两个会话同时用 air 的浏览器）。
5. **铺 mac-mini-2**：它现在是公网页面和家里内网的兜底机器，优先级跟 air 一样高（air 只管公司）。不需要公司登录态，隧道加一条 `-R 27783:127.0.0.1:8930` 即可。
6. 铺 mac-mini-1（公司备用，air 离线时接手；它曾有过 HTTP 探活正常但起 shell 卡死的毛病，验的时候留意）。
7. 改 skill `internal-web-via-mac`：删掉单活口和 `/mcp` 重连那两段，改成 `browser_node` 寻址。

---

## 十一、已知限制

- `storageState` 只带 cookie，不带 localStorage / IndexedDB / service worker。靠这些存 token 的站要走独占持久模式。
- 登录态过期没有自动发现，靠调用方落到登录页时触发 relogin。
- 需要人开盖登录一次 SSO —— mac 常态合盖挂机，headful 窗口人看不见。
- 并发上限受内存约束，不是无限；`concurrency` 是人工设的经验值，不是实测出来的容量。
- windows-4070ti 这个 node 先留空，链路（经 2201）没验过。
- **没有本机兜底了**（VPS 不跑浏览器带来的取舍）：三台 mac 全离线时，浏览器能力完全不可用，连看一个公网页面都不行——以前 VPS 本地至少能顶一下。实际风险不大，air 合盖不睡常在线、mini-2 在家常在线，两台在两个不同网络，同时挂的概率低；但公司整网断的时候 air 和 mini-1 是一起没的，那种情况只剩 mini-2。真需要本机兜底时，把 vps 节点加回配置就行，方案本身不排斥它。

---

## 十二、这次不做的

- **合并进 ssh-hub 同进程**（省 100M）：等稳定。
- **统一 profile 治理**：让 `tc-wiki` / `tc-langfuse` / `guanjia-doc` / `jean` 这些 skill 都走 browser-hub，不再各起 playwright 各攒登录态。收益大（登录态归一处、省磁盘、省内存），但要动 4 个以上 skill 和它们的脚本，单独一件事做。
- **清理 air 上 9 个残留 profile（约 2GB）**：用户 2026-08-17 明确说先别管。等新方案稳定、有价值的 cookie 都导成 storageState 之后再提，不自己动。
- **卸掉 VPS 上的 `@playwright/mcp` 0.0.68 + chromium**（约 400M 磁盘）：VPS 既然不跑浏览器，这套就没用了。顺手能省点磁盘（现在 72%），但不在这次范围，也不自己动。
- **从 mac 上用户日常 Chrome 导 cookie**：技术上可行（mac keychain 解密），比 playwright 自己的 profile 脆，不进主方案。
