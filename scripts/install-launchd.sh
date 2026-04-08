#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

NODE_PATH="$(which node 2>/dev/null || echo "/usr/local/bin/node")"
NVM_BIN="$(dirname "$NODE_PATH")"

echo "Bridge directory: $BRIDGE_DIR"
echo "Node binary: $NODE_PATH"

mkdir -p "$LAUNCH_AGENTS"

# ── bridge bot plist ──
BOT_PLIST="$LAUNCH_AGENTS/com.telegram-ai-bridge.bot.plist"
sed \
  -e "s|<string>node</string>|<string>$NODE_PATH</string>|" \
  -e "s|BRIDGE_DIR|$BRIDGE_DIR|" \
  -e "s|/usr/local/bin:/usr/bin:/bin|$NVM_BIN:/usr/local/bin:/usr/bin:/bin|" \
  "$BRIDGE_DIR/launchd/com.telegram-ai-bridge.bot.plist" \
  > "$BOT_PLIST"

echo "Installed: $BOT_PLIST"

echo ""
echo "The bridge now manages kilo serve automatically — no separate kilo plist needed."
echo ""
echo "To start now:"
echo "  launchctl load $BOT_PLIST"
echo ""
echo "To stop:"
echo "  launchctl unload $BOT_PLIST"
