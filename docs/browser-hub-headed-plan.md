# browser-hub 改有头浏览器：修改计划

> 2026-08-18 定稿，2026-08-19 执行完（结果记在 `docs/browser-hub.md` 第十五节）。
> 目标：三台 mac 上的浏览器改成有头（窗口开在 mac 屏幕上），用户能看见 agent 在点什么、
> 卡住时直接在那台 mac 上接手；browser-hub 要把"用户看得见、能接手"这件事明确告诉 agent。
> windows-4070ti 保持无头，这次不动。
>
> **执行时跟计划不一样的地方**：① 第 0 步查出 @playwright/mcp 0.0.75 在 isolated 下不释放已断开
> 会话的 context，三台 mac 全升到 0.0.79 才有"会话结束窗口关"；② 第一节里"navigator.webdriver 仍是
> true、有提示条"写错了，实测 playwright-mcp 带 `--disable-blink-features=AutomationControlled` 和
> `--disable-infobars`，webdriver 是 false、没有提示条；③ 会话回收阈值没动（仍 2h），改成 hub 里
> "上游连接 30 分钟没用就主动 DELETE"；④ 多修了三个顺带发现的问题：browser-hub 断连判断漏
> "Session not found"、`drop()` 不发 DELETE、`pw-up.sh`/`pw-down.sh` 不确认旧进程真死；
> ⑤ 没把 pw-up.sh 收进仓库（仍是各机器 `~/.mori/` 里的运维脚本，air 是参照）。

## 一、现状（2026-08-18 查证）

- 三台 mac 的 `~/.mori/pw-up.sh` 和 windows 的 `pw-up.ps1` 都写死 `--headless`。
  playwright-mcp 0.0.75 的默认就是有头（`--headless: run browser in headless mode, headed by default`），
  所以有头 = 把这个参数拿掉。
- 有头/无头是 daemon 级别的参数：一台机器一个 daemon、所有会话共用，只能按机器切，不能按会话切。
- mac 上从 ssh-hub 拉起的进程碰得到图形会话：ssh daemon 跑在 launchd 的 `gui/501` 域，用户一直登着 console
  （`who` 里 linsuki console 从 8/17 起就在）。`~/.mori/browser/relogin.sh start` 就是同一套 tmux 起法起的有头浏览器。
- windows 的 `pw-up.ps1` 走 WMI `Win32_Process.Create`，这种进程 Windows 明确不给交互桌面，
  想有头得改成由任务计划以"用户登录时交互运行"起。这次放弃。
- 有头之后会话遗留的窗口变得可见：browser-hub 的 HTTP 会话空闲回收是 2 小时（`src/index.ts` browser-hub 那档
  `defaultIdleMs`），Claude 会话正常结束会优雅关闭、上游 context 跟着关、窗口消失；非优雅断开（Claude 崩、隧道断）
  要等 2 小时。
- 反爬方面要说清楚：有头只去掉 headless 特有的特征（新版 headless 的 UA 已经和有头一样，剩的是 GPU、插件之类）。
  playwright 启动 Chrome 时带 `--enable-automation`，`navigator.webdriver` 仍是 true，playwright-mcp 没有开关关它。
  副产品：有头 Chrome 顶部会有一条"Chrome 正受到自动测试软件的控制"提示条——它正好是屏幕上分辨"哪个窗口是 agent 的"的标志。

## 二、设计决定

1. **mac 默认有头，环境变量回退。** `pw-up.sh` 去掉 `--headless`；`PW_HEADLESS=1 bash ~/.mori/pw-up.sh` 起回无头
   （对比排查、或者某台机器实在不想弹窗时用）。其它参数（`--isolated --storage-state --allowed-hosts`）不动。
2. **浏览器仍用 chrome channel（用户装的 Google Chrome）**，不换 `--browser chromium`。理由：反爬上真 Chrome 更像人；
   分辨 agent 窗口靠那条自动化提示条就够。要换成独立图标（Dock 上分开、可以指定到单独的桌面）再改，一个参数的事。
3. **hub.json 加一个声明字段 `browser.headed: true`**，三台 mac 加、windows 不加（缺省 = 无头）。它只用来生成给 agent 的提示，
   不参与拉起命令。老代码（2.9.3 的 ssh-hub / browser-hub）读到这个不认识的键会忽略，不会启动失败
   （BrowserSpec 是 TypeScript 接口，JSON.parse 不校验多余键）。
4. **提示 agent 的地方（核心）**，全在 `src/browser-hub.ts`：
   - `browser_node` 的工具描述加一句：mac 上的浏览器是有头的，窗口开在那台 mac 的屏幕上，用户可能正在看、也随时能接手；
     卡在验证码 / 扫码 / SSO 登录 / 必须人点的地方，直接告诉用户去哪台机器操作，然后 `browser_wait_for` 等他弄完，别自己反复试。
   - `list` 里每台机器加 `窗口: 有头（用户看得见、能接手）` / `窗口: 无头（没人看得见）`。
   - `connect` 的结果、以及首次自动路由时前置的那行说明（`prependNote`）加同一句，带机器名：
     "浏览器窗口开在 macbook-air 的屏幕上，用户能看见也能接手；要人操作的地方说一声再等"。
   - `status` 加实际模式探测（可选，低优先级）：经 ssh-hub 在那台机器跑 `pgrep -fl playwright-mcp` 看命令行里有没有 `--headless`，
     声明和实际不一致时明说。只在 status 做，list 不做（list 每次都要探三台，太重）。
5. **会话回收阈值从 2 小时降到 30 分钟（可选）**：让非优雅断开的会话遗留窗口少留一会儿。代价是会话停 30 分钟以上要重新导航。
   不想改就接受 2 小时。
6. **relogin.sh 不动。** 有头之后 agent 到了 SSO 页可以让用户直接在它的窗口里登，本会话马上能用；
   但 isolated 是内存 profile，登进去的 cookie 不落盘，`company.json` 还是要走 relogin.sh 刷新。

## 三、动手步骤

### 第 0 步：先在一台上验一次（10 分钟，可回滚）

选 macbook-air（用户在公司能开盖看到），挑没有别的会话在用它的时候（`browser_node({action:"list"})` 看 concurrency 是 0/3）。
经 ssh-hub 在 air 上：

```
tmux kill-session -t pwmcp
tmux new -d -s pwmcp "/opt/homebrew/bin/playwright-mcp --port 8930 --host 127.0.0.1 --isolated --storage-state ~/.mori/browser/state/company.json --allowed-hosts '*' > /tmp/pwmcp.log 2>&1"
```

然后从 VPS 这边 `browser_navigate` 一个内网页，请用户开盖看：

- 窗口出现了没有（这一步顺便回答"tmux 里起的进程到底碰不碰得到 WindowServer"）；
- 第二个会话再开一个页 → 是不是第二个窗口；
- 一个会话断开 → 它的窗口关不关；
- 合盖再开盖，窗口还在不在；
- 用户正在 air 上打字时，新窗口弹出来抢不抢焦点、烦不烦（这是有头的固有代价，受不了的话按机器配：mini-2 有头、air 无头）。

回滚 = `bash ~/.mori/pw-up.sh`（现在这份还是 `--headless`）。

### 第 1 步：改三台 mac 的 pw-up.sh

- 去掉 `--headless`；加 `PW_HEADLESS` 开关；输出那行写明"有头"或"无头（PW_HEADLESS=1）"。
- 三台改法一样（air 是参照，mini-1 / mini-2 照抄）。这些脚本不在 git 里、只在各机器 `~/.mori/`，经 ssh-hub 改没问题
  （跨机直传源码的红线管的是 git 仓库里的代码，不是这类机器本地的运维脚本）。
- 顺手把 pw-up.sh 收进仓库 `scripts/mac/pw-up.sh` 当参照副本，deploy-ssh-mcp 里"从 air 抄"改成"从仓库抄"（可选）。

### 第 2 步：hub.json

三台 mac 的 `browser` 段加 `"headed": true`。改完 `systemctl restart browser-hub`（hub.json 启动时读一次）。
ssh-hub 不用重启（它不认识也不需要这个键）。

### 第 3 步：代码（mcp-ssh-pty 2.9.4）

- `src/browser-config.ts`：`BrowserSpec` 加 `headed?: boolean`，注释写清"只影响给 agent 的提示"。
- `src/browser-hub.ts`：按第二节第 4 条改工具描述、`nodeSummary`、`connect` 结果、`prependNote` 那句、`status`。
- `src/index.ts`：browser-hub 的 `defaultIdleMs` 2h → 30min（如果第二节第 5 条采纳）。
- 发布：只能在 macbook-air 上 `npm publish`（要 2FA 一次性密码，见 memo `npm-publish-only-on-air`）；
  VPS 上 `npm i -g mcp-ssh-pty@2.9.4` 后 `systemctl restart browser-hub`。**不用重启 ssh-hub**（它的代码没变，
  重启会掐断所有会话的 ssh 连接）；三台 mac 的 daemon 也不用升（这次没改 ssh 侧）。
  别用 `npm install -g .` / `npm link` 覆盖已发布的全局包。

### 第 4 步：文档和提示文字

- `docs/browser-hub.md` 第四节：daemon 参数去掉 `--headless`，补一段"为什么有头、代价是什么、怎么回退"；
  第八节 relogin 补一句"有头之后可以直接在 agent 的窗口里登，但不落盘"。
- `skills/browser-hub/SKILL.md`（同步到 `~/.claude/skills/browser-hub/`）：加一节「浏览器是有头的：卡住怎么请用户接手」，
  写清固定动作——说清哪台机器、要他做什么 → `browser_wait_for` 等 → 继续；以及"这次登进去的登录态只活在本会话"。
- `skills/deploy-ssh-mcp/SKILL.md` 第 307 行那句"launchd 无 GUI 只能 headless"是错的（daemon 在 gui 域），改成
  "mac daemon 默认有头，`PW_HEADLESS=1` 回无头"。
- `~/.claude/CLAUDE.md` 🌐 那节加一句："mac 上的浏览器窗口用户看得见、能接手，卡在要人点的地方就说一声再等。"
- air 上 ssh shortcut `pw-up` 的描述里"8930 headless"改掉（`~/.mori/ssh/ssh-servers.json`，改完要重启那台 daemon 才生效，
  不急可以攒到下次一起）。

### 第 5 步：验收

- 两个会话同时在 air 开页面 → 屏幕上两个窗口，互不影响。
- 一个会话正常结束 → 它的窗口关掉。
- agent 落到 SSO 登录页 → `connect` / 首次路由的提示文字里有"用户能接手"那句 → 用户在屏幕上登录 → agent `browser_wait_for` 之后继续。
- `PW_HEADLESS=1 bash ~/.mori/pw-up.sh` 起回无头，`browser_node status` 探测出"声明有头、实际无头"。

## 四、可选的后续（这次不做，记在这）

- **登录后顺手导出登录态**：用户在 agent 的窗口里登完 SSO 后，agent 用 `browser_run_code_unsafe` 跑
  `await page.context().storageState({path: "~/.mori/browser/state/company.json"})`，`company.json` 就刷新了，
  不用再走 relogin.sh 的开盖跑脚本那一套。要留意 auto mode 分类器对 `browser_run_code_unsafe` 的态度。
- **agent 窗口换独立图标**：`--browser chromium`（playwright 自带的 Chromium），Dock 上和用户自己的 Chrome 分开，
  可以在 macOS 里把它指定到单独的桌面。反爬上比真 Chrome 差一点。
- **mac 侧通知**：agent 拉起 daemon 时 `osascript -e 'display notification ...'` 弹一条"Claude 在用这台的浏览器"。
  daemon 常驻之后 connect 不再执行 ssh 命令，所以只能在拉起时弹，价值有限。
- **windows 有头**：改任务计划 `MoriPwDaemon` 为交互式运行，pw-up.ps1 去掉 `--headless`。等真需要再做。

## 五、风险与注意

- **抢焦点**：用户在 air 上干活时，agent 开新窗口会弹到前面。有头的固有代价，第 0 步实验先感受一下；
  受不了就按机器配（air 无头、mini-2 有头），配置本来就是每台一份。
- **切换有头/无头要重跑 pw-up.sh，会关掉那台机器上所有会话的页面**——挑没人用的时候做。
- **合盖不影响**：窗口在关着的屏幕上照常存在，daemon 在 gui 域、`disablesleep` 已开，开盖就看见。
- **内存**：有头比无头略费（窗口、合成），三台 16G 的 mac 并发 3 个会话不是问题。
- **反爬别期待太高**：`navigator.webdriver` 仍是 true，见第一节。
