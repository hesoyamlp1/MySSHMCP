#!/bin/bash
# mac1 迁移脚本：升级到 mcp-ssh-pty v2.2.0+ 并用带 VSCode 防抢逻辑的新版 plist
#
# 使用：在 mac1 上直接跑
#   bash migrate-mac1.sh
#
# 幂等：重复跑安全，已是新版会识别并跳过相应步骤
#
# 做的事：
#   1. 升级 mcp-ssh-pty 到最新
#   2. ~/.ssh/authorized_keys 追加自己的 pub key（ssh-loopback 免密）
#   3. 重写 plist，带"启动时 kill 抢 27777 的 VSCode Helper"逻辑
#   4. 保留 mac 特定的 node nvm 路径（自动探测）
#   5. 重载 launchd

set -e

PORT=27777
LABEL="com.mori.mcp-ssh-pty-http"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TOKEN_FILE="$HOME/.mori/ssh/http-token"

echo "=== mac mcp-ssh-pty 迁移到 v2.2.0+ 带防抢逻辑 ==="

# ---- 1. 升级 mcp-ssh-pty ----
echo "[1/5] 升级 mcp-ssh-pty..."
npm i -g @mori-mori/mcp-ssh-pty >/dev/null 2>&1 || {
  echo "  !! npm install 失败，继续"
}
PKG_VER=$(cat "$(npm root -g)/@mori-mori/mcp-ssh-pty/package.json" 2>/dev/null | grep '"version"' | head -1 | sed -E 's/.*"([^"]+)",?/\1/')
echo "  mcp-ssh-pty version: $PKG_VER"
case "$PKG_VER" in
  2.2.*|2.3.*|2.4.*|2.5.*|2.[6-9].*|3.*|4.*)
    echo "  ✓ 版本符合要求（>= 2.2.0）"
    ;;
  *)
    echo "  !! 版本 $PKG_VER 可能太旧，仍继续，但 connect local 可能失败"
    ;;
esac

# ---- 2. ssh-loopback 授权 ----
echo "[2/5] 配置 SSH loopback 授权..."
AK="$HOME/.ssh/authorized_keys"
if [ ! -f "$HOME/.ssh/id_ed25519.pub" ]; then
  echo "  !! 找不到 ~/.ssh/id_ed25519.pub，生成一把..."
  ssh-keygen -t ed25519 -f "$HOME/.ssh/id_ed25519" -N "" -q
fi
PUB_KEY_FP=$(awk '{print $2}' "$HOME/.ssh/id_ed25519.pub")
if [ -f "$AK" ] && grep -q "$PUB_KEY_FP" "$AK"; then
  echo "  ✓ 自己的 pub key 已在 authorized_keys"
else
  cat "$HOME/.ssh/id_ed25519.pub" >> "$AK"
  echo "  ✓ 已追加自己的 pub key"
fi
chmod 600 "$AK"

# ---- 3. 准备 token（如不存在让用户自己填）----
echo "[3/5] 检查 token..."
if [ ! -f "$TOKEN_FILE" ]; then
  echo "  !! token 文件不存在：$TOKEN_FILE"
  echo "     请手动写入与 VPS 侧 claude mcp add 的 Bearer 值一致的字符串，然后重跑本脚本"
  mkdir -p "$(dirname "$TOKEN_FILE")"
  exit 1
fi
TOKEN=$(cat "$TOKEN_FILE" | tr -d '\n')
if [ -z "$TOKEN" ]; then
  echo "  !! token 文件为空，请填好再重跑"
  exit 1
fi
chmod 600 "$TOKEN_FILE"
echo "  ✓ token 就位（长度 ${#TOKEN}）"

# ---- 4. 探测 node 路径 ----
echo "[4/5] 探测 node 路径..."
NODE_BIN=$(which node)
MCP_BIN=$(which mcp-ssh-pty)
NODE_DIR=$(dirname "$NODE_BIN")
if [ -z "$NODE_BIN" ] || [ -z "$MCP_BIN" ]; then
  echo "  !! 找不到 node 或 mcp-ssh-pty，请确认 nvm 已加载"
  exit 1
fi
echo "  node: $NODE_BIN"
echo "  mcp:  $MCP_BIN"

# ---- 5. 写 plist（带自动 kill VSCode Helper 的 wrapper）----
echo "[5/5] 写 plist 并重载 launchd..."
mkdir -p "$HOME/Library/LaunchAgents"
if [ -f "$PLIST" ]; then
  cp "$PLIST" "$PLIST.bak-$(date +%Y%m%d_%H%M%S)"
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>PORT=$PORT; PID=\$(lsof -tiTCP:\$PORT -sTCP:LISTEN 2>/dev/null); if [ -n "\$PID" ]; then CMD=\$(ps -p \$PID -o comm= 2>/dev/null); case "\$CMD" in *[Cc]ode*|*lectron*) kill -9 \$PID; sleep 0.3;; esac; fi; exec $MCP_BIN --http --port \$PORT --host 127.0.0.1</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$NODE_DIR:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
        <key>SHELL</key>
        <string>/bin/zsh</string>
        <key>MCP_HTTP_TOKEN</key>
        <string>$TOKEN</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/.mori/ssh/mcp-http.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.mori/ssh/mcp-http.err</string>
    <key>WorkingDirectory</key>
    <string>$HOME</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST" || { echo "  !! plist lint 失败"; exit 1; }

# 先 unload 老的，再 load 新的
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 1.5

STATUS=$(launchctl list | grep "$LABEL" || true)
echo "  launchd: $STATUS"

if lsof -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | grep -q node; then
  echo "  ✓ daemon 起来了，监听 $PORT"
else
  echo "  !! daemon 未监听 $PORT，看 $HOME/.mori/ssh/mcp-http.err 排查"
  tail -5 "$HOME/.mori/ssh/mcp-http.err" 2>/dev/null | sed 's/^/    /'
fi

echo ""
echo "=== 完成 ==="
echo ""
echo "验证链路（在 VPS 上跑）："
echo "  curl -sS http://127.0.0.1:$PORT/health"
echo "  claude mcp list | grep ssh-mac"
echo ""
echo "如果 VPS 侧连不上，检查反向隧道：ss -tlnp | grep :$PORT"
echo "  若无监听 → mac 上 ssh -fN vircs （或 VSCode 重连）让 RemoteForward 生效"
