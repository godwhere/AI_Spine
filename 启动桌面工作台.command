#!/bin/zsh
set -e
cd "$(dirname "$0")"
if /usr/bin/curl --silent --fail http://127.0.0.1:4175/api/workspace/status >/dev/null; then
  exec /usr/bin/open http://127.0.0.1:4175
fi
for spine_node in "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [[ -x "$spine_node" ]]; then
    exec "$spine_node" scripts/start-workbench.mjs --open
  fi
done
print '未找到本机工作台运行环境。需要 Node.js 24 或更新版本。'
read -k 1
