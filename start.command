#!/usr/bin/env bash
# Double-click this file on macOS, or run ./start.command in a terminal,
# to launch Lumen RSS and open it in your default browser.
set -euo pipefail
cd "$(dirname "$0")"

# Prefer whatever Node is on PATH, then fall back to common install locations.
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.local/bin/node" \
    "$HOME/.nvm/versions/node"/*/bin/node; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "未找到 Node.js。请先安装 Node.js 22.5 或更高版本：https://nodejs.org/"
  read -r -p "按回车键关闭…" _ || true
  exit 1
fi

# node:sqlite requires Node 22.5+ (experimental, stable enough for this app).
if ! "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)'; then
  echo "需要 Node.js 22.5 或更高版本（依赖内置 node:sqlite）。当前版本：$("$NODE_BIN" -v)"
  read -r -p "按回车键关闭…" _ || true
  exit 1
fi

PORT="${PORT:-5178}"

# Open the browser a moment after the server starts listening.
if command -v open >/dev/null 2>&1; then
  ( sleep 2 && open "http://127.0.0.1:${PORT}" ) &
elif command -v xdg-open >/dev/null 2>&1; then
  ( sleep 2 && xdg-open "http://127.0.0.1:${PORT}" ) &
fi

exec "$NODE_BIN" --disable-warning=ExperimentalWarning server/index.js --port "$PORT"
