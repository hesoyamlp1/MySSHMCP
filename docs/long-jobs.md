# 长任务设计：detach + jobs

状态：**代码化暂不做，改走提示词**（2026-08-17 决定，随 v2.9.2 发布）。
下面第四到九节是完整的代码化方案，留着备查——什么时候该把它做出来，见本节末尾的判据。

一句话：把「长任务丢 tmux」这条已经被验证过的正确写法，从每次手写变成一个参数。

**为什么先不做代码化**：`mode:"detach"` 这套**不增加任何能力**——模型自己写一行 `tmux new -d`
就能达到同样效果。它的价值只是不用每次重复、不会写错。而这次查下来，模型没这么做的原因
不是它做不到，是提示词自相矛盾（见下面第一节末尾），修文案的成本比写代码低一个量级。

v2.9.2 改了三处文案：
1. `timeout` 参数描述里那句「长时间命令建议设置较大值」——它在直接鼓励用大 timeout 同步等，
   跟 tmux 那条指引方向相反，而且离模型填参数的那一刻更近。改成明确说「超过 5 分钟别靠它」。
2. 单机 ssh 工具的 command 描述里加了「长任务」一节，跟 exec / pty 并列，给出可直接抄的完整写法。
   原来 tmux 只在 hub 工具描述的**括号**里出现过一次，单机工具里一个字都没有。
3. 超时返回的标注里加一行现场提示（`src/tools.ts` 的 `shapeExecResult`）——在模型刚撞墙的
   那一刻给正确做法，比在描述里写一百遍都管用。

**什么时候回来做代码化**：观察一段时间，如果发现模型确实反复写错（忘了输出重定向、忘了写
`.status`、日志路径各写各的、或者又用回 nohup），那就是提示词到顶了，按第四到九节实现。
在此之前不做——没有证据的代码化只是把复杂度提前买进来。

---

## 一、为什么要做：三条独立的记录都指向同一件事

**1. `mcp-ssh-pty` 自己的工具描述里就写着这句**（`src/hub.ts:100`）：

> 多台 mac 的连接互相独立、可同时活着；切 node 不影响其它 node 上正在跑的东西（**长任务照例丢 tmux**）。

约定俗成的做法已经写进描述了，但工具本身不提供它。

**2. `pw-up.sh` 里踩过一次，注释是今天写的**（mac-mini-2，第 13 行）：

```bash
# 必须用 tmux 起（别改成 nohup）：ssh daemon 被 launchctl kickstart -k 重启时，会杀掉
# 自己进程组里的所有后台进程，nohup + disown 都挡不住（2026-08-17 实测）。
tmux new -d -s pwmcp "$PW $ARGS > $LOG 2>&1"
```

也就是说：**经 ssh 通道起的后台进程，默认是活不过 daemon 重启的**。`ppid=1` 也不管用，进程组还是 daemon 的。判存活要看 PGID/SESS，不是 PPID。

**3. 外部评审（codex，003 实施期间）把它列为第一短板**：

> 现在测试/构建最长只能等 300 秒，超时后「进程到底还在不在、杀的是不是整个进程组」不够清楚。

再加上代码里的一处实情：超时后那句 `stream.signal("KILL")`（`src/exec-runner.ts:98`）对 OpenSSH 基本是空操作——sshd 至今不实现 signal channel request，所以**超时只是我们不看了，远端进程多半还在跑**。

三条合起来：长任务现在能起（手写 tmux），但起得不规范、找不回、不知道完没完。

---

## 二、不做什么

先划边界，因为这块最容易做大。

| 不做 | 为什么 |
|---|---|
| job 表 / 状态机 / 数据库 | 状态一旦存进 hub 进程，一次升级就全丢。hub 是常驻 daemon，2026-08-17 当天就重启过一次 |
| 轮询接口（`poll_job` 每 N 秒问一次） | 把等待成本转嫁给模型的上下文和轮次。要的是「一次问清楚」，不是「问很多次」 |
| 涨 `timeout` 上限（300s → 1800s） | 涨了只是让会话干等半小时。该 detach 的任务不该占着一次同步调用 |
| 跨机 job 编排（A 机跑完触发 B 机） | 那是编排层的事，不是通道层的事 |
| 在 hub 里托管进程 | browser-hub 已经立了规矩：hub 只存「怎么起、怎么停」的命令字符串，进程活在目标机上 |

一条总的边界：**hub 路由，不托管**。它现在是 9 个会话的公共依赖，挂一次全员受影响；任何让它自己需要被运维的东西都不该进来。

---

## 三、为什么是 tmux，不是别的

| 方案 | 抗 daemon 重启 | 有名字能找回 | 能 attach 进去看 | 结论 |
|---|---|---|---|---|
| `nohup` + `disown` | ❌ 实测挡不住 kickstart -k | ❌ 只有 pid | ❌ | 排除 |
| `setsid` | ✅ 新建 session，能活 | ❌ 只有 pid，重启后不好找 | ❌ | 可用但难用 |
| launchd / systemd | ✅ | ✅ | ❌ | 适合长期服务，不适合一次性任务；要写 plist/unit |
| **tmux** | ✅ | ✅ session 名就是 id | ✅ | **选它** |

tmux 额外的三个好处：目标机上本来就装着（三台 mac + VPS，用户自己重度依赖）；`pw-up.sh` 已经在用同一套写法，两边模式统一；用户可以自己 `tmux attach` 上去看，不必经过模型。

---

## 四、接口设计

### 4.1 起任务

```js
ssh({ node:"mac-mini-2", server:"local", command:"npm test", cwd:"/repo",
      mode:"detach", name:"test-003" })
```

返回（纯文本，跟 2.8.0 的原生风格一致）：

```
已在 mac-mini-2:local 起 job「test-003」
  tmux session : mcp-test-003
  日志         : ~/.mori/jobs/test-003.log
  看进度       : ssh({action:"log", name:"test-003"})
```

- `name` 不传时按命令首词加序号生成（`npm-test-2`），返回里带上实际用的名字。
- 同名且**还在跑**时直接报错，不覆盖——绝不默默杀掉别人的任务。同名但已结束时，日志归档成 `<name>.log.1` 后复用这个名字。

### 4.2 看有哪些任务

```js
ssh({ action:"jobs" })            // 当前 node/server 上的
```

```
running  test-003    起于 12:31 (4m)   npm test              /repo
done     build-web   rc=0  用时 6m12s  npm run build         /repo
failed   lint-all    rc=1  用时 22s    npx eslint .          /repo
killed   old-sync    12:02             rsync -a ...          /data
```

### 4.3 看输出

```js
ssh({ action:"log", name:"test-003", lines:50 })   // 默认 50，-1 全部
```

走已有的 `saveIfLarge`：超长就存盘、正文只留尾部，跟 exec 的大输出处理一致。

### 4.4 停任务

```js
ssh({ action:"kill", name:"test-003" })
```

`tmux kill-session`，并写一条 `killed` 进 status 文件（否则它会永远显示 running）。

---

## 五、目标机上到底跑什么

这一节是实现的核心，坑都在这里。

### 5.1 目录

```
~/.mori/jobs/
  test-003.sh       实际执行的脚本（用户命令原样落进去）
  test-003.meta     起始时间 / cwd / 原始命令，一行 JSON
  test-003.log      stdout + stderr 合并
  test-003.status   完成后才出现：rc=0 end=2026-08-17T12:37:11Z
```

**status 文件是完成通知的第一档**，也是整个设计里最省事的一块：模型只要读这一个几十字节的文件就知道完没完、成没成，不用把日志拉进上下文。

**为什么必须落文件而不能只靠 tmux**：tmux session 在命令结束的一刻就消失了。只查 `tmux ls` 的话，跑完的任务和从没存在过的任务长得一模一样。所以 `jobs` 的数据来源是 meta 文件，tmux 只用来判断「还在不在跑」。

### 5.2 命令构造：不要拼引号

用户命令里随时可能有单双引号、`$`、反引号。往 `tmux new -d -s x "..."` 里拼是自找麻烦（PTY 那边的 heredoc 卡死就是同类问题）。

**做法：先把命令写成脚本文件，tmux 只负责跑那个文件。** 写文件用已有的 exec + stdin 通道喂 base64，彻底绕开转义：

```bash
mkdir -p ~/.mori/jobs && base64 -d > ~/.mori/jobs/test-003.sh   # stdin 喂 base64
```

脚本内容（模板）：

```bash
#!/bin/bash
cd -- '<cwd>' || exit 127
{
<用户的 command 原样>
} > ~/.mori/jobs/test-003.log 2>&1
echo "rc=$? end=$(date -u +%FT%TZ)" > ~/.mori/jobs/test-003.status
```

用 `{ ...; }` 包住是为了：用户命令是多行、或者带管道时，重定向仍然作用于整体。用户命令里有 `exit` 的话 rc 拿不到——这种情况 status 文件不会出现，`jobs` 显示为 `unknown`（见第七节）。

然后：

```bash
tmux new -d -s mcp-test-003 "bash ~/.mori/jobs/test-003.sh"
```

### 5.3 tmux 不在怎么办

起任务前先 `command -v tmux`。没有的话**明确报错**，告诉调用方这台机器不支持 detach、可以用什么替代——不要静默退回 nohup，那会让人以为任务能活过 daemon 重启，其实不能。

---

## 六、跨平台：windows 是个真口子

`windows-4070ti` 在 hub.json 里 `up/down` 是空的，它也没有 tmux。它挂在 `vps` 节点下面（`via:"vps"` + `server:"windows-4070ti"`），是个正经的执行目标，不能假装它不存在。

三个选项，建议第一个：

1. **先做成 unix-only，windows 上返回明确错误**并指路（用任务计划，参照 `MoriTunnelVircs` 那套：`C:\ProgramData\ssh\tunnel\`）。口子留着，但不骗人。
2. hub.json 的 node 段加 `jobRunner: "tmux" | "schtasks" | "none"`，按机器选实现。
3. windows 上用 `Start-Process -WindowStyle Hidden` + 输出重定向。能起，但没有名字、找回麻烦，跟 tmux 那套不同构。

---

## 七、失败模式清单

写实现时每条都要有对应处理，不能靠运气。

| 情况 | 表现 | 处理 |
|---|---|---|
| 用户命令里有 `exit` | status 文件永不出现，tmux session 也没了 | `jobs` 显示 `unknown`（有 meta、无 status、无 session），并提示看日志尾部 |
| 机器重启 | tmux session 全没了，status 也没写 | 同上，`unknown`。meta 里记了起始时间，能看出是很久以前的 |
| 日志无限增长（`tail -f` 之类） | 磁盘涨 | 写入端不限（限了会让任务本身出错）；`log` 读取端已有 `saveIfLarge` 截断。`jobs` 里顺带显示日志大小，超过阈值给一行提示 |
| 同名任务还在跑 | — | 报错，不覆盖 |
| 旧 job 文件堆积 | `~/.mori/jobs/` 越攒越多 | `jobs` 默认只列最近 20 条，末尾提示清理命令。**不自动删**——用户可能还要看 |
| 日志目录在 VPS 上涨起来 | VPS 磁盘已经 73% | VPS 本机（`node:"vps", server:"local"`）跑长任务本来就该少；`jobs` 显示占用即可 |

---

## 八、代码落点

| 文件 | 改什么 |
|---|---|
| `src/tool-schemas.ts` | `mode` 枚举加 `"detach"`；`action` 枚举加 `"jobs" / "log" / "kill"`；加 `name` 参数（复用已有的 `lines`） |
| `src/job-runner.ts`（新，约 150 行） | 构造脚本模板、base64 落盘、起 tmux、解析 `tmux ls`、读 meta/status、拼 `jobs` 表格 |
| `src/tools.ts` | `mode:"detach"` 走 job-runner；三个新 action 各一个分支 |
| `src/hub.ts` | **不用改**。hub 原样转发 action 和参数，新能力自动对所有 node 可用 |
| `README.md` / skill `deploy-ssh-mcp` | 补一节用法 |

工作量估计一天以内。发版是 2.10.0（加了工具面的新语义，不是补丁）。

---

## 九、验收

在 mac-mini-2 上跑这一串，每步都要对：

1. `mode:"detach"` 起一个 `sleep 20; echo done`，立即返回，不阻塞
2. 马上 `action:"jobs"` → 显示 `running`
3. `action:"log"` → 能看到已有输出
4. **期间在那台机上跑一次 `launchctl kickstart -k` 重启 ssh daemon**，任务必须还活着——这是整个设计要解决的核心问题，不验这条等于没做
5. 20 秒后 `jobs` → `done rc=0`
6. 起一个 `exit 3` 的任务 → `failed rc=3`
7. `action:"kill"` 一个在跑的 → `killed`，且 tmux session 确实没了
8. 在 windows-4070ti 上试 → 明确报错，不是静默失败

---

## 十、这个方案没解决什么

**跑完了主动叫醒模型，做不到。** MCP 是请求-响应，服务端不能主动推。status 文件把「问一次的成本」压到了几十字节，但还是得有人去问。

真需要「跑完主动通知」的时候，做法是任务脚本末尾加一行 `curl` 打回 VPS 上的一个端点，由它写 trail 或发通知。那个端点**不该住在 ssh-hub 里**——hub 是路由器，不是消息总线。这件事等到确实被这个问题卡住了再做，不要提前做。

**和 browser-hub 的关系**：`pw-up.sh` 用 tmux 起 playwright daemon，跟这里的 detach 是同一个模式的两个实例。将来可以让 browser 的 `up/down` 复用 job-runner，但没必要现在做——那边已经跑通了，动它只有风险没有收益。
