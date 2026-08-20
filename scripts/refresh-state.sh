#!/bin/bash
# 自动刷新 browser-hub 用的登录态（company.json），不用等人想起来。
#
# 为什么需要它：browser-hub 的 daemon 用 --isolated 跑，每个会话一个内存 profile，
# 登录态靠 --storage-state 从 company.json 注入。这份 json 是 export-state.sh 从持久
# profile 导出的快照，会过期。tc-wiki / tc-langfuse / tc-configcenter 的 bootstrap
# 脚本都有这层自愈（失效就重新从持久 profile 导一次，全失效才提示人登一次），
# 只有 company.json 一直靠手动跑 export-state.sh。这个脚本补上那一步。
#
# 做什么：扫所有持久 profile，挑出还带着未过期公司 cookie 的，交给 export-state.sh
# 合并导出，然后按域白名单把结果过一遍。一个有效的都没有就退 2，提示跑 relogin.sh。
#
# 为什么导完还要过滤：export-state.sh 导的是整个 profile 的 storageState，不分域。
# 手动只传两三个干净 profile 时看不出问题，一旦自动把「含公司 cookie 的 profile」
# 全收进来，个人站的登录态（PayPal / Amazon / Google / Shopify 后台 / 飞书）也会
# 一起进 company.json——而 browser-hub 会把这份文件注入到每个 isolated 浏览器会话里。
# 所以最后必须按白名单裁一刀，只留公司的域。
#
# 退出码跟 tc-* 的 bootstrap 对齐：
#   0  导出成功
#   2  所有 profile 都没有有效的公司登录态，要人工登一次
#   1  其它错误（缺 export-state.sh、缺 sqlite3、缺缓存目录）
#
# 用法：
#   bash ~/.mori/browser/refresh-state.sh           扫描 + 导出
#   bash ~/.mori/browser/refresh-state.sh --check   只报告哪些 profile 还有效，不导出
#
# 权威副本在仓库 scripts/refresh-state.sh，各机 ~/.mori/browser/ 下的是它的副本。
# 导出的 company.json 是明文 SSO cookie：别入 git、别跨机传、别放 /tmp。

set -eu

CACHE="$HOME/Library/Caches/ms-playwright"
EXPORT_SH="$HOME/.mori/browser/export-state.sh"

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

[ -f "$EXPORT_SH" ] || { echo "找不到 export-state.sh: $EXPORT_SH"; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "没有 sqlite3，读不了 profile 的 cookie"; exit 1; }
[ -d "$CACHE" ] || { echo "没有 playwright 缓存目录: $CACHE"; exit 1; }

# 判定「这个 profile 还登着公司的站」用的域。要加新域改这里。
# Chrome 的 expires_utc 是 1601-01-01 起的微秒数；0 表示 session cookie，当作有效。
NOW_CHROME=$(( ($(date +%s) + 11644473600) * 1000000 ))
WHERE="(host_key like '%17u.cn%' or host_key like '%17usoft.com%' or host_key like '%elong.com%')"
WHERE="$WHERE and (expires_utc = 0 or expires_utc > $NOW_CHROME)"

# 用空格分隔的字符串攒结果，不用数组：mac 自带的是 bash 3.2，
# set -u 下引用空数组会直接报 unbound variable。
good=""

echo "扫描持久 profile: $CACHE"
for d in "$CACHE"/mcp-chrome-*; do
  [ -d "$d" ] || continue
  suffix="${d##*mcp-chrome-}"
  ck="$d/Default/Cookies"
  if [ ! -f "$ck" ]; then
    echo "  $suffix  没有 Cookies 文件，跳过"
    continue
  fi
  # 复制一份再读：源 profile 可能正被 playwright 用着，直接打开会撞锁
  tmp="/tmp/refresh-ck-$suffix.db"
  if ! cp "$ck" "$tmp" 2>/dev/null; then
    echo "  $suffix  Cookies 读不出来，跳过"
    continue
  fi
  n=$(sqlite3 "$tmp" "select count(*) from cookies where $WHERE;" 2>/dev/null || echo 0)
  rm -f "$tmp"
  if [ "${n:-0}" -gt 0 ]; then
    echo "  $suffix  有 $n 条未过期的公司 cookie"
    good="$good $suffix"
  else
    echo "  $suffix  没有有效的公司登录态"
  fi
done

good=$(echo $good | xargs || true)

if [ -z "$good" ]; then
  echo ""
  echo "所有 profile 都没有有效的公司登录态，自动重导这条路走不通了。"
  echo "要人在这台机器上登一次："
  echo "  bash ~/.mori/browser/relogin.sh start"
  echo "  （有头浏览器会开在这台机器的屏幕上，登完再跑 relogin.sh finish）"
  exit 2
fi

echo ""
echo "还有效的 profile: $good"

if [ "$CHECK_ONLY" = "1" ]; then
  echo "（--check 模式，没有导出）"
  exit 0
fi

echo "交给 export-state.sh 导出"
# 后缀是十六进制、不含空格，这里故意不加引号，让它拆成多个参数
bash "$EXPORT_SH" $good

# 裁掉非公司域。export-state.sh 导的是整个 profile，混着个人站的登录态，
# 而 company.json 会被注入到每个 isolated 浏览器会话里，不能什么都带。
OUT="$HOME/.mori/browser/state/company.json"
FILTER="$HOME/.mori/browser/filter-company-state.cjs"
echo ""
if [ -f "$FILTER" ]; then
  echo "按白名单过滤非公司域"
  node "$FILTER" "$OUT"
  chmod 600 "$OUT"
else
  echo "找不到 $FILTER —— 没有过滤，company.json 里可能混着个人站的登录态！"
  echo "把仓库 scripts/filter-company-state.cjs 复制到 ~/.mori/browser/ 再跑一次。"
  exit 1
fi
