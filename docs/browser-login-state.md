# 公司浏览器登录态是怎么回事

一句话：**持久 profile 是唯一源头，company.json 是从它导出的快照**。不是两套并列的东西。

## 三个角色

| 东西 | 在哪 | 谁读它 |
|---|---|---|
| 持久 profile | `~/Library/Caches/ms-playwright/mcp-chrome-<后缀>` | tc-wiki / tc-langfuse / tc-configcenter 的 bootstrap 脚本直接遍历这些目录找有效 cookie |
| company.json | `~/.mori/browser/state/company.json` | browser-hub 的 daemon 用 `--storage-state` 注入到每个 isolated 会话 |
| relogin.sh | `~/.mori/browser/` | 往持久 profile 里种登录态的**唯一入口** |

browser-hub 的 daemon 跑 `--isolated`（每个会话一个内存 profile，好处是能并发），而内存 profile
登完 cookie 不落盘、种不回去。所以"补登录态"必须单独有条路，就是 relogin.sh。

## 四个脚本

```
relogin.sh start <后缀>    起一个 headful 的持久 profile 浏览器，人在那台机器前面登一次 SSO
relogin.sh finish <后缀>   关掉它 + 导出 company.json + 按域白名单过滤
refresh-state.sh           登录态过期时自动重导：扫所有 profile 挑出还有效的，导出 + 过滤
refresh-state.sh --check   只报告哪些 profile 还有效，不导出
list-profiles.sh           看有哪些 profile、各存了什么站
export-state.sh <后缀>...  底层导出工具，一般不直接用（不做域过滤，见下）
```

`refresh-state.sh` 的退出码跟 tc-* 的 bootstrap 对齐：`0` 导出成功 / `2` 所有 profile 都失效了
要人工 relogin / `1` 其它错误。

## 一个必须知道的坑：导出必须按域裁

`export-state.sh` 导的是**整个 profile 的 storageState，不分域**。而 company.json 会被注入到
每个用 browser-hub 打开的浏览器会话里——所以它里面有什么，任何会话就带着什么。

2026-08-20 真踩过：自动挑出 8 个"含公司 cookie 的 profile"全导，合并出 122 个 cookie、43 个域，
混着 PayPal、Amazon、Google、Shopify 后台、飞书、TikTok。当场回滚。

手动只传两三个干净 profile 时看不出这个问题，一自动化就暴露了。

所以 `refresh-state.sh` 和 `relogin.sh finish` 都会在导出后调 `filter-company-state.cjs`
按白名单裁一刀。要放行新域，改那个文件里的 `KEEP` 数组。

## 另外两条规矩

- **company.json 不跨机传**。它是明文 SSO cookie。哪台机器要登录态，就在那台上跑 relogin.sh。
- **profile 后缀各机不同**，别照抄。跑 `list-profiles.sh` 看这台有哪些、哪个碰过公司域。
  relogin.sh 默认写死 `33da8b6`，那是 air 上管家那份；mini-1 上要用 `8074aa6`。

## 权威副本

`refresh-state.sh` 和 `filter-company-state.cjs` 在本仓库 `scripts/` 下，各机
`~/.mori/browser/` 里的是副本。`relogin.sh` / `export-state.sh` / `list-profiles.sh`
目前只在各机本地，没纳入仓库。
