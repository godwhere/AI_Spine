#!/bin/zsh
set -e
cd "$(dirname "$0")"
if [[ -d "outputs/desktop/AI Spine.app" ]]; then
  exec /usr/bin/open "$PWD/outputs/desktop/AI Spine.app"
fi
for spine_node in "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [[ -x "$spine_node" ]]; then
    exec "$spine_node" scripts/start-desktop.mjs
  fi
done
print '未找到 Node.js。请安装 Node.js 22 或更新版本，或打开打包后的 AI Spine.app。'
read -k 1
